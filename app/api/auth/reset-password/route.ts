
import { db, users, passwordResets } from "@/lib/auth/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { hashPassword } from "@/lib/auth/password";
import { revokeAllUserSessions } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/activity";
import { ResetPasswordSchema } from "@/lib/auth/schemas";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiSuccess,
  apiError,
  apiBadRequest,
  apiServerError,
} from "@/lib/shared/api-response";

export async function POST(request: Request) {
  try {
    await initializeAuth();

    const body = await request.json();
    const parsed = ResetPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { token, password } = parsed.data;

    const resetRecord = await db
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.token, token),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .get();

    if (!resetRecord) {
      return apiError(
        "Invalid or expired reset link. Please request a new one.",
        400,
      );
    }

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, resetRecord.userId))
      .get();

    if (!user) {
      return apiError("User not found", 404);
    }

    const passwordHash = await hashPassword(password);

    await db
      .update(users)
      .set({
        passwordHash,
        status: "active", // Activate if pending
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(eq(passwordResets.id, resetRecord.id));

    await revokeAllUserSessions(user.id);

    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "password_reset_complete",
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0] || undefined,
    });

    return apiSuccess({
      message:
        "Password reset successful. Please log in with your new password.",
    });
  } catch (error) {
    return apiServerError(error, "Auth/ResetPassword");
  }
}
