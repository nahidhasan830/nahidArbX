
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { getGeoLocation, parseDeviceInfo } from "@/lib/auth/geo";
import { getUserPermissions } from "@/lib/auth/features/permissions";
import { LoginSchema } from "@/lib/auth/schemas";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  rateLimitResponse,
  resetRateLimit,
  createRateLimitKey,
} from "@/lib/auth/rate-limit";
import {
  apiError,
  apiBadRequest,
  apiServerError,
} from "@/lib/shared/api-response";

export async function POST(request: Request) {
  try {
    await initializeAuth();

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

    const rateLimited = rateLimitResponse("login", ip);
    if (rateLimited) return rateLimited;

    const body = await request.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { email, password } = parsed.data;

    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get();

    if (!user || !user.passwordHash) {
      return apiError("Invalid email or password", 401);
    }

    if (user.status === "suspended") {
      return apiError(
        "Your account has been suspended. Please contact the administrator.",
        403,
      );
    }

    if (user.status === "pending") {
      return apiError(
        "Please complete your registration first. Check your email for the invite link.",
        403,
      );
    }

    const isValid = await verifyPassword(password, user.passwordHash);

    if (!isValid) {
      await logActivity({
        userId: user.id,
        userEmail: user.email,
        action: "login_failed",
        ipAddress: ip,
        deviceInfo: request.headers.get("user-agent") || undefined,
      });

      return apiError("Invalid email or password", 401);
    }

    const userAgent = request.headers.get("user-agent");
    const deviceInfo = parseDeviceInfo(userAgent);
    const geo = await getGeoLocation(ip);

    const { token } = await createSession(user.id, {
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
    });

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "login",
      ipAddress: ip,
      geoLocation: geo,
      deviceInfo,
    });

    resetRateLimit(createRateLimitKey("login", ip));

    const permissions = await getUserPermissions(user.id);

    const response = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        permissions,
      },
    });

    response.cookies.set("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60, // 24 hours
    });

    return response;
  } catch (error) {
    return apiServerError(error, "Auth/Login");
  }
}
