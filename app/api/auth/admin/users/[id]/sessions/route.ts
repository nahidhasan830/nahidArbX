/**
 * GET /api/auth/admin/users/[id]/sessions
 * DELETE /api/auth/admin/users/[id]/sessions
 *
 * Get and manage user sessions (admin only).
 */

import { cookies } from "next/headers";
import { db, users, sessions } from "@/lib/auth/db";
import { validateSession, revokeSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { eq, desc } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiSuccess,
  apiNotFound,
  apiServerError,
} from "@/lib/shared/api-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET - Get user sessions
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

    // Get all sessions for this user
    const userSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, id))
      .orderBy(desc(sessions.createdAt));

    const now = new Date();

    // Format sessions for response
    const formattedSessions = userSessions.map((s) => ({
      id: s.id,
      deviceInfo: s.deviceInfo,
      ipAddress: s.ipAddress,
      geoLocation: s.geoLocation ? JSON.parse(s.geoLocation) : null,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: s.revokedAt?.toISOString() || null,
      isActive: !s.revokedAt && s.expiresAt > now,
      isCurrent: user.currentSessionId === s.id,
      isImpersonation: s.isImpersonation,
    }));

    return apiSuccess({
      userId: user.id,
      sessions: formattedSessions,
      totalCount: formattedSessions.length,
      activeCount: formattedSessions.filter((s) => s.isActive).length,
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Sessions/GET");
  }
}

/**
 * DELETE - Revoke a specific session
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

    const adminSession = await validateSession(token);

    if (!adminSession || adminSession.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    // Get user
    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    // Parse body to get session ID
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return apiError("Session ID required", 400);
    }

    // Verify session belongs to this user
    const targetSession = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();

    if (!targetSession || targetSession.userId !== id) {
      return apiNotFound("Session not found");
    }

    if (targetSession.revokedAt) {
      return apiError("Session already revoked", 400);
    }

    // Revoke the session
    await revokeSession(sessionId);

    // If this was the user's current session, clear it
    if (user.currentSessionId === sessionId) {
      await db
        .update(users)
        .set({ currentSessionId: null, updatedAt: new Date() })
        .where(eq(users.id, id));
    }

    // Log activity
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "force_logout",
      performedBy: adminSession.userId,
      metadata: { sessionId, revokedBy: "admin" },
    });

    return apiSuccess({ message: "Session revoked" });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Sessions/DELETE");
  }
}
