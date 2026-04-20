/**
 * POST /api/auth/admin/stop-impersonate
 *
 * Stop impersonating and return to admin session.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { validateSession, revokeSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { getUserPermissions } from "@/lib/auth/features/permissions";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import { apiError, apiServerError } from "@/lib/shared/api-response";

export async function POST() {
  try {
    await initializeAuth();

    const cookieStore = await cookies();
    const currentToken = cookieStore.get("auth_token")?.value;
    const adminToken = cookieStore.get("admin_token")?.value;

    if (!currentToken) {
      return apiError("Not authenticated", 401);
    }

    // Validate current (impersonation) session
    const currentSession = await validateSession(currentToken);

    if (!currentSession || !currentSession.isImpersonation) {
      return apiError("Not currently impersonating", 400);
    }

    if (!adminToken) {
      return apiError("Admin session not found. Please log in again.", 400);
    }

    // Validate admin token
    const adminSession = await validateSession(adminToken);

    if (!adminSession || adminSession.role !== "admin") {
      return apiError("Admin session invalid. Please log in again.", 400);
    }

    // Get impersonated user for logging
    const impersonatedUser = await db
      .select()
      .from(users)
      .where(eq(users.id, currentSession.userId))
      .get();

    // Get admin user
    const adminUser = await db
      .select()
      .from(users)
      .where(eq(users.id, adminSession.userId))
      .get();

    // Revoke impersonation session
    await revokeSession(currentSession.sessionId);

    // Log activity
    if (impersonatedUser) {
      await logActivity({
        userId: impersonatedUser.id,
        userEmail: impersonatedUser.email,
        action: "impersonation_ended",
        performedBy: adminSession.userId,
        metadata: { adminEmail: adminUser?.email },
      });
    }

    // Get admin permissions
    const permissions = adminUser ? await getUserPermissions(adminUser.id) : {};

    // Restore admin session
    const response = NextResponse.json({
      ok: true,
      user: adminUser
        ? {
            id: adminUser.id,
            email: adminUser.email,
            displayName: adminUser.displayName,
            role: adminUser.role,
            permissions,
            isImpersonation: false,
          }
        : null,
    });

    // Restore admin token as auth token
    response.cookies.set("auth_token", adminToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    // Clear admin token cookie
    response.cookies.delete("admin_token");

    return response;
  } catch (error) {
    return apiServerError(error, "Admin/StopImpersonate/POST");
  }
}
