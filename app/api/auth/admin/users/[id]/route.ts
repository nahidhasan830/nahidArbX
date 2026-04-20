/**
 * GET /api/auth/admin/users/[id]
 * PATCH /api/auth/admin/users/[id]
 * DELETE /api/auth/admin/users/[id]
 *
 * User management endpoints (admin only).
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { validateSession, revokeAllUserSessions } from "@/lib/auth/session";
import { getUserPermissions } from "@/lib/auth/features/permissions";
import { logActivity } from "@/lib/auth/activity";
import { UpdateUserSchema } from "@/lib/auth/schemas";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiSuccess,
  apiBadRequest,
  apiNotFound,
  apiServerError,
} from "@/lib/shared/api-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET - Get user details
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    // Check auth
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    // Get user
    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    // Get permissions
    const permissions = await getUserPermissions(user.id);

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        permissions,
      },
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/GET");
  }
}

/**
 * PATCH - Update user (suspend/activate/update display name)
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    // Check auth
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    // Get user
    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    // Prevent admin from modifying themselves
    if (user.id === session.userId) {
      return apiError("Cannot modify your own account", 400);
    }

    // Parse body
    const body = await request.json();
    const parsed = UpdateUserSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { displayName, status } = parsed.data;
    const now = new Date();

    // Build update object
    const updates: Partial<typeof users.$inferInsert> = {
      updatedAt: now,
    };

    if (displayName !== undefined) {
      updates.displayName = displayName;
    }

    if (status !== undefined) {
      updates.status = status;

      // If suspending, revoke all sessions
      if (status === "suspended") {
        await revokeAllUserSessions(user.id);

        await logActivity({
          userId: user.id,
          userEmail: user.email,
          action: "account_suspended",
          performedBy: session.userId,
        });
      } else if (status === "active" && user.status === "suspended") {
        await logActivity({
          userId: user.id,
          userEmail: user.email,
          action: "account_activated",
          performedBy: session.userId,
        });
      }
    }

    // Update user
    await db.update(users).set(updates).where(eq(users.id, id));

    return apiSuccess({ message: "User updated" });
  } catch (error) {
    return apiServerError(error, "Admin/Users/PATCH");
  }
}

/**
 * DELETE - Delete user (keeps activity logs)
 */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    // Check auth
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    // Get user
    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    // Prevent admin from deleting themselves
    if (user.id === session.userId) {
      return apiError("Cannot delete your own account", 400);
    }

    // Note: Admins CAN delete other admins - full control

    // Log before deletion (activity logs are kept)
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "account_deleted",
      performedBy: session.userId,
    });

    // Revoke sessions first
    await revokeAllUserSessions(user.id);

    // Delete user (cascade will delete permissions, sessions, invites)
    await db.delete(users).where(eq(users.id, id));

    return apiSuccess({ message: "User deleted" });
  } catch (error) {
    return apiServerError(error, "Admin/Users/DELETE");
  }
}
