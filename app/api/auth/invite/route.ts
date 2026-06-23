
import { cookies } from "next/headers";
import { db, users, invites } from "@/lib/auth/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { validateSession } from "@/lib/auth/session";
import { sendInviteEmail } from "@/lib/auth/email";
import { logActivity } from "@/lib/auth/activity";
import { InviteUserSchema } from "@/lib/auth/schemas";
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

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session) {
      return apiError("Session expired", 401);
    }

    if (session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    const body = await request.json();
    const parsed = InviteUserSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { email, displayName } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .get();

    if (existingUser && existingUser.status === "active") {
      return apiError(
        "A user with this email already exists and is active",
        400,
      );
    }

    const existingInvite = await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.email, normalizedEmail),
          isNull(invites.usedAt),
          gt(invites.expiresAt, new Date()),
        ),
      )
      .get();

    const inviteToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const now = new Date();

    if (existingInvite) {
      await db
        .update(invites)
        .set({ usedAt: now })
        .where(eq(invites.id, existingInvite.id));
    }

    if (!existingUser) {
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email: normalizedEmail,
        displayName: displayName || null,
        role: "user",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await db
        .update(users)
        .set({
          displayName: displayName || existingUser.displayName,
          status: "pending",
          updatedAt: now,
        })
        .where(eq(users.id, existingUser.id));
    }

    await db.insert(invites).values({
      id: crypto.randomUUID(),
      email: normalizedEmail,
      token: inviteToken,
      invitedBy: session.userId,
      expiresAt,
      createdAt: now,
    });

    const emailResult = await sendInviteEmail(
      normalizedEmail,
      inviteToken,
      session.email,
    );

    if (!emailResult.success) {
      return apiError(`Failed to send invite email: ${emailResult.error}`, 500);
    }

    const invitedUser = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .get();

    if (invitedUser) {
      await logActivity({
        userId: invitedUser.id,
        userEmail: invitedUser.email,
        action: "invite_sent",
        performedBy: session.userId,
        metadata: { inviterEmail: session.email },
      });
    }

    const response: {
      message: string;
      email: string;
      emailNotConfigured?: boolean;
      setupUrl?: string;
    } = {
      message: emailResult.emailNotConfigured
        ? `Invite created for ${normalizedEmail} (email not configured - share the link manually)`
        : `Invite sent to ${normalizedEmail}`,
      email: normalizedEmail,
    };

    if (emailResult.emailNotConfigured && emailResult.manualUrl) {
      response.emailNotConfigured = true;
      response.setupUrl = emailResult.manualUrl;
    }

    return apiSuccess(response);
  } catch (error) {
    return apiServerError(error, "Auth/Invite");
  }
}
