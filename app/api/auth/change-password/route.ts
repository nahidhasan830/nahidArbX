/**
 * POST /api/auth/change-password
 *
 * Changes password for authenticated user.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  validateSession,
  revokeAllUserSessions,
  createSession,
} from "@/lib/auth/session";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { logActivity } from "@/lib/auth/activity";
import { getGeoLocation, parseDeviceInfo } from "@/lib/auth/geo";
import { db, users } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import { ChangePasswordSchema } from "@/lib/auth/schemas";
import {
  apiError,
  apiBadRequest,
  apiServerError,
} from "@/lib/shared/api-response";

export async function POST(request: Request) {
  try {
    // Get current session
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session) {
      return apiError("Session expired", 401);
    }

    // Parse body
    const body = await request.json();
    const parsed = ChangePasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { currentPassword, newPassword } = parsed.data;

    // Get user
    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .get();

    if (!user || !user.passwordHash) {
      return apiError("User not found", 404);
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, user.passwordHash);

    if (!isValid) {
      return apiError("Current password is incorrect", 400);
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password
    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    // Revoke all sessions for security
    await revokeAllUserSessions(user.id);

    // Get request metadata
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const userAgent = request.headers.get("user-agent");
    const deviceInfo = parseDeviceInfo(userAgent);
    const geo = await getGeoLocation(ip);

    // Create new session
    const { token: newToken } = await createSession(user.id, {
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
    });

    // Log activity
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "password_change",
      ipAddress: ip,
      geoLocation: geo,
      deviceInfo,
    });

    // Set new cookie
    const response = NextResponse.json({ ok: true });
    response.cookies.set("auth_token", newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    return response;
  } catch (error) {
    return apiServerError(error, "Auth/ChangePassword");
  }
}
