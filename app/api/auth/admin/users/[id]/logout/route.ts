/**
 * POST /api/auth/admin/users/[id]/logout
 *
 * Force logout a user by revoking all their sessions (admin only).
 */

import { cookies } from "next/headers";
import { db, users } from "@/lib/auth/db";
import { validateSession, revokeAllUserSessions } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { eq } from "drizzle-orm";
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

export async function POST(request: Request, context: RouteContext) {
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

    // Prevent admin from logging themselves out via this endpoint
    if (user.id === session.userId) {
      return apiError(
        "Use the normal logout endpoint for your own session",
        400,
      );
    }

    // Revoke all sessions for the user
    const revokedCount = await revokeAllUserSessions(user.id);

    // Log activity
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "force_logout",
      performedBy: session.userId,
      metadata: { revokedSessions: revokedCount },
    });

    return apiSuccess({
      message: `User logged out successfully`,
      revokedSessions: revokedCount,
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Logout/POST");
  }
}
