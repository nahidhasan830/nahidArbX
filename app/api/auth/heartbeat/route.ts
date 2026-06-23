
import { cookies } from "next/headers";
import { validateSession } from "@/lib/auth/session";
import { db, users } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import { apiSuccess, apiError } from "@/lib/shared/api-response";

export async function POST() {
  try {
    if (process.env.NODE_ENV === "development") {
      return apiSuccess({ timestamp: new Date().toISOString() });
    }

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session) {
      return apiError("Session expired", 401);
    }

    const now = new Date();

    await db
      .update(users)
      .set({ updatedAt: now })
      .where(eq(users.id, session.userId));

    return apiSuccess({ timestamp: now.toISOString() });
  } catch {
    return apiSuccess({ timestamp: new Date().toISOString() });
  }
}
