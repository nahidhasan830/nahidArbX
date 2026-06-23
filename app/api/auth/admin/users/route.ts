
import { cookies } from "next/headers";
import { db, users, sessions } from "@/lib/auth/db";
import { validateSession } from "@/lib/auth/session";
import { getUserPermissions } from "@/lib/auth/features/permissions";
import { getUserActivitySummary } from "@/lib/auth/activity";
import { eq, desc } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import { apiError, apiServerError } from "@/lib/shared/api-response";
import { NextResponse } from "next/server";

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

export async function GET() {
  try {
    await initializeAuth();

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    const allUsers = await db
      .select()
      .from(users)
      .orderBy(desc(users.createdAt));

    const now = new Date();
    const _onlineThreshold = new Date(now.getTime() - ONLINE_THRESHOLD_MS);

    const userList = await Promise.all(
      allUsers.map(async (user) => {
        const permissions = await getUserPermissions(user.id);

        const activitySummary = await getUserActivitySummary(user.id);

        let isOnline = false;
        let currentDevice = null;
        if (user.currentSessionId) {
          const activeSession = await db
            .select()
            .from(sessions)
            .where(eq(sessions.id, user.currentSessionId))
            .get();

          if (
            activeSession &&
            !activeSession.revokedAt &&
            activeSession.expiresAt > now
          ) {
            isOnline = true;
            currentDevice = activeSession.deviceInfo;
          }
        }

        return {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          isOnline,
          currentDevice,
          permissions,
          activitySummary: {
            totalLogins: activitySummary.totalLogins,
            lastLogin: activitySummary.lastLogin,
            lastLoginIp: activitySummary.lastLoginIp,
            lastLoginDevice: activitySummary.lastLoginDevice,
            lastLoginLocation: activitySummary.lastLoginLocation,
          },
        };
      }),
    );

    return NextResponse.json({
      ok: true,
      users: userList,
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/GET");
  }
}
