
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db, users } from "@/lib/auth/db";
import { validateSession } from "@/lib/auth/session";
import { getAllActivityLogs } from "@/lib/auth/activity";
import { eq } from "drizzle-orm";
import { initializeAuth } from "@/lib/auth/bootstrap";
import {
  apiError,
  apiNotFound,
  apiServerError,
} from "@/lib/shared/api-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    await initializeAuth();
    const { id } = await context.params;

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session || session.role !== "admin") {
      return apiError("Admin access required", 403);
    }

    const user = await db.select().from(users).where(eq(users.id, id)).get();

    if (!user) {
      return apiNotFound("User not found");
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const logs = await getAllActivityLogs({
      userId: user.id,
      limit,
      offset,
    });

    return NextResponse.json({
      ok: true,
      userId: user.id,
      userEmail: user.email,
      logs,
      pagination: {
        limit,
        offset,
        hasMore: logs.length === limit,
      },
    });
  } catch (error) {
    return apiServerError(error, "Admin/Users/Activity/GET");
  }
}
