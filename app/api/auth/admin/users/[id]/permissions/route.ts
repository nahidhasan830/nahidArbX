
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { validateSession } from "@/lib/auth/session";
import {
  getUserPermissions,
  setPermissions,
} from "@/lib/auth/features/permissions";
import { logActivity } from "@/lib/auth/activity";
import { FEATURE_REGISTRY } from "@/lib/auth/features/registry";
import { UpdatePermissionsSchema } from "@/lib/auth/schemas";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiBadRequest,
  apiNotFound,
  apiServerError,
} from "@/lib/shared/api-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    const permissions = await getUserPermissions(user.id);

    const permissionsWithMetadata = Object.entries(FEATURE_REGISTRY).map(
      ([featureId, metadata]) => ({
        featureId,
        displayName: metadata.displayName,
        description: metadata.description,
        category: metadata.category,
        defaultEnabled: metadata.defaultEnabled,
        adminOnly: "adminOnly" in metadata ? metadata.adminOnly : false,
        implemented: "implemented" in metadata ? metadata.implemented : true,
        enabled: permissions[featureId] ?? metadata.defaultEnabled,
      }),
    );

    return NextResponse.json({
      ok: true,
      userId: user.id,
      userEmail: user.email,
      permissions: permissionsWithMetadata,
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Permissions/GET");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    if (user.role === "admin" && user.id !== session.userId) {
      return apiError("Cannot modify another admin's permissions", 400);
    }

    const body = await request.json();
    const parsed = UpdatePermissionsSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { permissions } = parsed.data;

    const implementedPermissions: Record<string, boolean> = {};
    for (const [featureId, enabled] of Object.entries(permissions)) {
      const feature =
        FEATURE_REGISTRY[featureId as keyof typeof FEATURE_REGISTRY];
      if (feature && ("implemented" in feature ? feature.implemented : true)) {
        implementedPermissions[featureId] = enabled;
      }
    }

    await setPermissions(user.id, implementedPermissions);

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "permissions_updated",
      performedBy: session.userId,
      metadata: { permissions },
    });

    const updatedPermissions = await getUserPermissions(user.id);

    return NextResponse.json({
      ok: true,
      message: "Permissions updated",
      permissions: updatedPermissions,
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Permissions/PATCH");
  }
}
