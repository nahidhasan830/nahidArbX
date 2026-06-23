
import { NextResponse } from "next/server";
import { db, users, invites } from "@/lib/auth/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { initializeUserPermissions } from "@/lib/auth/features/permissions";
import { getGeoLocation, parseDeviceInfo } from "@/lib/auth/geo";
import { SetupPasswordSchema } from "@/lib/auth/schemas";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiBadRequest,
  apiServerError,
} from "@/lib/shared/api-response";

export async function GET(request: Request) {
  try {
    await initializeAuth();

    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return apiBadRequest("Token is required");
    }

    const invite = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.token, token),
          isNull(invites.usedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .get();

    if (!invite) {
      return apiError("Invalid or expired invite link", 400);
    }

    return NextResponse.json({
      ok: true,
      email: invite.email,
    });
  } catch (error) {
    return apiServerError(error, "Auth/SetupPassword/GET");
  }
}

export async function POST(request: Request) {
  try {
    await initializeAuth();

    const body = await request.json();
    const parsed = SetupPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { token, password, displayName } = parsed.data;

    const invite = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.token, token),
          isNull(invites.usedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .get();

    if (!invite) {
      return apiError(
        "Invalid or expired invite link. Please request a new invite.",
        400,
      );
    }

    let user = await db
      .select()
      .from(users)
      .where(eq(users.email, invite.email.toLowerCase()))
      .get();

    const now = new Date();
    const passwordHash = await hashPassword(password);

    if (user) {
      await db
        .update(users)
        .set({
          passwordHash,
          displayName: displayName || user.displayName,
          status: "active",
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
    } else {
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        email: invite.email.toLowerCase(),
        displayName: displayName || null,
        passwordHash,
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      await initializeUserPermissions(userId);

      user = await db.select().from(users).where(eq(users.id, userId)).get();
    }

    if (!user) {
      return apiError("Failed to create user", 500);
    }

    await db
      .update(invites)
      .set({ usedAt: now })
      .where(eq(invites.id, invite.id));

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    const userAgent = request.headers.get("user-agent");
    const deviceInfo = parseDeviceInfo(userAgent);
    const geo = await getGeoLocation(ip);

    const { token: authToken } = await createSession(user.id, {
      ipAddress: ip,
      deviceInfo,
      geoLocation: geo,
    });

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "invite_accepted",
      ipAddress: ip,
      geoLocation: geo,
      deviceInfo,
    });

    const response = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    });

    response.cookies.set("auth_token", authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
    });

    return response;
  } catch (error) {
    return apiServerError(error, "Auth/SetupPassword/POST");
  }
}
