/**
 * GET /api/auth/profile
 * PATCH /api/auth/profile
 *
 * Get or update the current user's profile (display name).
 */

import { cookies } from "next/headers";
import { db, users } from "@/lib/auth/db";
import { validateSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import { z } from "zod";
import {
  apiError,
  apiSuccess,
  apiBadRequest,
  apiServerError,
} from "@/lib/shared/api-response";

const UpdateProfileSchema = z.object({
  displayName: z
    .string()
    .min(1, "Display name is required")
    .max(100, "Display name too long")
    .trim(),
});

export async function GET() {
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

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .get();

    if (!user) {
      return apiError("User not found", 404);
    }

    return apiSuccess({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    });
  } catch (error) {
    return apiServerError(error, "Profile/GET");
  }
}

export async function PATCH(request: Request) {
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

    const body = await request.json();
    const parsed = UpdateProfileSchema.safeParse(body);

    if (!parsed.success) {
      return apiBadRequest(parsed.error.issues[0]?.message || "Invalid input");
    }

    const { displayName } = parsed.data;

    // Update user
    await db
      .update(users)
      .set({
        displayName,
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.userId));

    return apiSuccess({
      message: "Profile updated",
      displayName,
    });
  } catch (error) {
    return apiServerError(error, "Profile/PATCH");
  }
}
