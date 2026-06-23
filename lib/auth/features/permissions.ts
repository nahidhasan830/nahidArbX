
import { db, users, userPermissions } from "../db";
import { eq, and } from "drizzle-orm";
import {
  FEATURE_IDS,
  getFeatureDefaultEnabled,
  isAdminOnlyFeature,
} from "./registry";


export interface UserPermissions {
  [featureId: string]: boolean;
}


export async function getUserPermissions(
  userId: string,
): Promise<UserPermissions> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  const isAdmin = user?.role === "admin";

  const permissions: UserPermissions = {};
  for (const featureId of FEATURE_IDS) {
    permissions[featureId] = isAdminOnlyFeature(featureId) ? isAdmin : true;
  }
  return permissions;
}

export async function hasPermission(
  userId: string,
  featureId: string,
): Promise<boolean> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  const isAdmin = user?.role === "admin";

  if (isAdminOnlyFeature(featureId)) {
    return isAdmin;
  }

  const userPerm = await db
    .select()
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.featureId, featureId),
      ),
    )
    .get();

  if (userPerm !== undefined) {
    return userPerm.enabled;
  }

  return isAdmin ? true : getFeatureDefaultEnabled(featureId);
}

export async function setPermission(
  userId: string,
  featureId: string,
  enabled: boolean,
): Promise<void> {
  const existing = await db
    .select()
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.featureId, featureId),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(userPermissions)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(userPermissions.id, existing.id));
  } else {
    await db.insert(userPermissions).values({
      id: crypto.randomUUID(),
      userId,
      featureId,
      enabled,
      updatedAt: new Date(),
    });
  }
}

export async function setPermissions(
  userId: string,
  permissions: UserPermissions,
): Promise<void> {
  for (const [featureId, enabled] of Object.entries(permissions)) {
    if (isAdminOnlyFeature(featureId)) {
      continue;
    }

    await setPermission(userId, featureId, enabled);
  }
}

export async function initializeUserPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    if (isAdminOnlyFeature(featureId)) {
      continue;
    }

    const defaultEnabled = getFeatureDefaultEnabled(featureId);

    await db.insert(userPermissions).values({
      id: crypto.randomUUID(),
      userId,
      featureId,
      enabled: defaultEnabled,
      updatedAt: new Date(),
    });
  }
}

export async function hasAnyPermission(userId: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId);

  return Object.values(permissions).some((enabled) => enabled);
}

export async function grantDefaultPermissions(userId: string): Promise<void> {
  await initializeUserPermissions(userId);
}

export async function grantAllPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    if (isAdminOnlyFeature(featureId)) {
      continue;
    }

    await setPermission(userId, featureId, true);
  }
}

export async function revokeAllPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    await setPermission(userId, featureId, false);
  }
}
