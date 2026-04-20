/**
 * POST /api/auth/forgot-password
 *
 * Sends password reset email.
 * Rate limited: 3 attempts per hour per IP.
 */

import { db, users, passwordResets } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import { sendPasswordResetEmail } from "@/lib/auth/email";
import { logActivity } from "@/lib/auth/activity";
import { ForgotPasswordSchema } from "@/lib/auth/schemas";
import { initializeAuth } from "@/lib/auth/bootstrap";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import {
  apiSuccess,
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
    const rateLimited = rateLimitResponse("passwordReset", ip);
    if (rateLimited) return rateLimited;

    // Parse body
    const body = await request.json();
    const parsed = ForgotPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { email } = parsed.data;

    // Find user (don't reveal if user exists)
    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get();

    // Always return success to prevent email enumeration
    if (!user) {
      return apiSuccess({
        message:
          "If an account exists with this email, a reset link has been sent.",
      });
    }

    // Check if user can reset password
    if (user.status === "suspended") {
      return apiSuccess({
        message:
          "If an account exists with this email, a reset link has been sent.",
      });
    }

    // Create reset token
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResets).values({
      id: crypto.randomUUID(),
      userId: user.id,
      token,
      expiresAt,
      createdAt: new Date(),
    });

    // Send email
    const emailResult = await sendPasswordResetEmail(user.email, token);

    // Log activity
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "password_reset_request",
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0] || undefined,
    });

    // Build response with email status
    const response: {
      message: string;
      emailNotConfigured?: boolean;
      resetUrl?: string;
    } = {
      message: emailResult.emailNotConfigured
        ? "Email not configured. Use the link below to reset your password."
        : "If an account exists with this email, a reset link has been sent.",
    };

    if (emailResult.emailNotConfigured && emailResult.manualUrl) {
      response.emailNotConfigured = true;
      response.resetUrl = emailResult.manualUrl;
    }

    return apiSuccess(response);
  } catch (error) {
    return apiServerError(error, "Auth/ForgotPassword");
  }
}
