/**
 * POST /api/auth/login
 *
 * Authenticates user with email/password.
 * Creates session, logs activity, sets HTTP-only cookie.
 * Rate limited: 5 attempts per 15 minutes per IP.
 */

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
    // Ensure auth is initialized
    await initializeAuth();

    // Get client IP for rate limiting
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

    // Check rate limit
    const rateLimited = rateLimitResponse("login", ip);
    if (rateLimited) return rateLimited;

    // Parse and validate body
    const body = await request.json();
    const parsed = LoginSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { email, password } = parsed.data;

    // Find user
    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get();

    if (!user || !user.passwordHash) {
      return apiError("Invalid email or password", 401);
    }

    // Check user status
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

    // Verify password
    const isValid = await verifyPassword(password, user.passwordHash);

    if (!isValid) {
      // Log failed attempt
      await logActivity({
        userId: user.id,
        userEmail: user.email,
        action: "login_failed",
        ipAddress: ip,
        deviceInfo: request.headers.get("user-agent") || undefined,
      });

      return apiError("Invalid email or password", 401);
    }

    // Get request metadata
    const userAgent = request.headers.get("user-agent");
    const deviceInfo = parseDeviceInfo(userAgent);
    const geo = await getGeoLocation(ip);

    // Create session
    const { token } = await createSession(user.id, {
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
    });

    // Log successful login
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "login",
      ipAddress: ip,
      geoLocation: geo,
      deviceInfo,
    });

    // Reset rate limit on successful login
    resetRateLimit(createRateLimitKey("login", ip));

    // Get permissions
    const permissions = await getUserPermissions(user.id);

    // Set HTTP-only cookie and return user data
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
