
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { validateSession, createSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { getUserPermissions } from "@/lib/auth/features/permissions";
import { ImpersonateSchema } from "@/lib/auth/schemas";
import { getGeoLocation, parseDeviceInfo } from "@/lib/auth/geo";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiBadRequest,
  apiNotFound,
  apiServerError,
} from "@/lib/shared/api-response";

export async function POST(request: Request) {
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

    if (session.isImpersonation) {
      return apiError(
        "Already impersonating. Stop current impersonation first.",
        400,
      );
    }

    const body = await request.json();
    const parsed = ImpersonateSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { userId } = parsed.data;

    const targetUser = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();

    if (!targetUser) {
      return apiNotFound("User not found");
    }

    if (targetUser.id === session.userId) {
      return apiError("Cannot impersonate yourself", 400);
    }


    const adminUser = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .get();

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const userAgent = request.headers.get("user-agent");
    const deviceInfo = parseDeviceInfo(userAgent);
    const geo = await getGeoLocation(ip);

    const { token: impersonationToken } = await createSession(targetUser.id, {
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
      isImpersonation: true,
      impersonatedBy: session.userId,
      realUserEmail: adminUser?.email,
    });

    await logActivity({
      userId: targetUser.id,
      userEmail: targetUser.email,
      action: "impersonation_started",
      performedBy: session.userId,
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
      metadata: { adminEmail: adminUser?.email },
    });

    const permissions = await getUserPermissions(targetUser.id);

    const response = NextResponse.json({
      ok: true,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        displayName: targetUser.displayName,
        role: targetUser.role,
        permissions,
        isImpersonation: true,
        realUserEmail: adminUser?.email,
      },
    });

    response.cookies.set("auth_token", impersonationToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    response.cookies.set("admin_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    return response;
  } catch (error) {
    return apiServerError(error, "Admin/Impersonate/POST");
  }
}
