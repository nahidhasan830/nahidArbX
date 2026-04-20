/**
 * POST /api/auth/logout
 *
 * Logs out current user.
 * Revokes session and clears cookie.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { validateSession, revokeSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { db, users } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import { apiSuccess, apiServerError } from "@/lib/shared/api-response";

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (token) {
      // Validate and revoke session
      const session = await validateSession(token);

      if (session) {
        await revokeSession(session.sessionId);

        // Get user for logging
        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, session.userId))
          .get();

        if (user) {
          await logActivity({
            userId: user.id,
            userEmail: user.email,
            action: "logout",
            ipAddress:
              request.headers.get("x-forwarded-for")?.split(",")[0] ||
              undefined,
          });
        }
      }
    }

    // Clear cookie
    const response = NextResponse.json({ ok: true });
    response.cookies.delete("auth_token");

    // Also clear admin token if present (from impersonation)
    response.cookies.delete("admin_token");

    return response;
  } catch (error) {
    return apiServerError(error, "Auth/Logout");
  }
}
