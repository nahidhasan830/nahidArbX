
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
    await initializeAuth();

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";

    const rateLimited = rateLimitResponse("passwordReset", ip);
    if (rateLimited) return rateLimited;

    const body = await request.json();
    const parsed = ForgotPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { email } = parsed.data;

    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get();

    if (!user) {
      return apiSuccess({
        message:
          "If an account exists with this email, a reset link has been sent.",
      });
    }

    if (user.status === "suspended") {
      return apiSuccess({
        message:
          "If an account exists with this email, a reset link has been sent.",
      });
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db.insert(passwordResets).values({
      id: crypto.randomUUID(),
      userId: user.id,
      token,
      expiresAt,
      createdAt: new Date(),
    });

    const emailResult = await sendPasswordResetEmail(user.email, token);

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "password_reset_request",
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0] || undefined,
    });

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
