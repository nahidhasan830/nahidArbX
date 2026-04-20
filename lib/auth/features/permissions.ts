/**
 * Permissions Module
 *
 * Functions for checking and managing per-user feature permissions.
 */

import { db, users, userPermissions } from "../db";
import { eq, and } from "drizzle-orm";
import {
  FEATURE_IDS,
  FEATURE_REGISTRY,
  type FeatureId,
  getFeatureDefaultEnabled,
  isAdminOnlyFeature,
} from "./registry";

// ============================================
// Types
// ============================================

export interface UserPermissions {
  [featureId: string]: boolean;
}

// ============================================
// Functions
// ============================================

/**
 * Get all permissions for a user
 *
 * Admins can self-disable non-admin-only features for testing.
 * Admin-only features are always enabled for admins.
 */
export async function getUserPermissions(
  userId: string,
): Promise<UserPermissions> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  const isAdmin = user?.role === "admin";

  // Get user's specific permissions from DB (applies to both admins and regular users)
  const userPerms = await db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));

  // Build permissions object
  const permissions: UserPermissions = {};

  for (const featureId of FEATURE_IDS) {
    // Admin-only features: always true for admins, always false for non-admins
    if (isAdminOnlyFeature(featureId)) {
      permissions[featureId] = isAdmin;
      continue;
    }

    // Check if user has explicit permission override in DB
    const userPerm = userPerms.find((p) => p.featureId === featureId);

    if (userPerm !== undefined) {
      // Use explicit override (allows admins to self-disable features)
      permissions[featureId] = userPerm.enabled;
    } else {
      // No override: admins get true, regular users get registry default
      permissions[featureId] = isAdmin
        ? true
        : getFeatureDefaultEnabled(featureId);
    }
  }

  return permissions;
}

/**
 * Check if user has a specific permission
 *
 * Admins can self-disable non-admin-only features for testing.
 * Admin-only features are always enabled for admins.
 */
export async function hasPermission(
  userId: string,
  featureId: string,
): Promise<boolean> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  const isAdmin = user?.role === "admin";

  // Admin-only features: always true for admins, always false for non-admins
  if (isAdminOnlyFeature(featureId)) {
    return isAdmin;
  }

  // Check explicit permission override in DB
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
    // Use explicit override (allows admins to self-disable features)
    return userPerm.enabled;
  }

  // No override: admins get true, regular users get registry default
  return isAdmin ? true : getFeatureDefaultEnabled(featureId);
}

/**
 * Set permission for a user
 */
export async function setPermission(
  userId: string,
  featureId: string,
  enabled: boolean,
): Promise<void> {
  // Check if permission record exists
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

/**
 * Set multiple permissions for a user
 */
export async function setPermissions(
  userId: string,
  permissions: UserPermissions,
): Promise<void> {
  for (const [featureId, enabled] of Object.entries(permissions)) {
    // Skip admin-only features
    if (isAdminOnlyFeature(featureId)) {
      continue;
    }

    await setPermission(userId, featureId, enabled);
  }
}

/**
 * Initialize default permissions for a new user
 */
export async function initializeUserPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    // Skip admin-only features
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

/**
 * Check if user has ANY enabled features (for locked state check)
 */
export async function hasAnyPermission(userId: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId);

  return Object.values(permissions).some((enabled) => enabled);
}

/**
 * Grant all default permissions to a user
 */
export async function grantDefaultPermissions(userId: string): Promise<void> {
  await initializeUserPermissions(userId);
}

/**
 * Grant all permissions to a user (admin use)
 */
export async function grantAllPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    // Skip admin-only features for non-admins
    if (isAdminOnlyFeature(featureId)) {
      continue;
    }

    await setPermission(userId, featureId, true);
  }
}

/**
 * Revoke all permissions from a user
 */
export async function revokeAllPermissions(userId: string): Promise<void> {
  for (const featureId of FEATURE_IDS) {
    await setPermission(userId, featureId, false);
  }
}
