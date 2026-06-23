
import { cookies } from "next/headers";
import { validateSession } from "@/lib/auth/session";
import { db, users } from "@/lib/auth/db";
import { eq } from "drizzle-orm";
import {
  getUserPermissions,
  hasAnyPermission,
} from "@/lib/auth/features/permissions";
import { devPermissions } from "@/lib/auth/middleware/auth";
import { initializeAuth } from "@/lib/auth/bootstrap";
import { apiError, apiServerError } from "@/lib/shared/api-response";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    if (process.env.NODE_ENV === "development") {
      return NextResponse.json({
        ok: true,
        user: {
          id: "dev-user",
          email: "dev@local",
          displayName: "Dev User",
          role: "admin",
          status: "active",
          permissions: devPermissions(),
          hasAccess: true,
          isImpersonation: false,
        },
      });
    }

    await initializeAuth();

    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;

    if (!token) {
      return apiError("Not authenticated", 401);
    }

    const session = await validateSession(token);

    if (!session) {
      const response = NextResponse.json(
        { ok: false, error: "Session expired" },
        { status: 401 },
      );
      response.cookies.delete("auth_token");
      return response;
    }

    const user = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .get();

    if (!user) {
      return apiError("User not found", 401);
    }

    if (user.status === "suspended") {
      const response = NextResponse.json(
        { ok: false, error: "Account suspended" },
        { status: 403 },
      );
      response.cookies.delete("auth_token");
      return response;
    }

    const permissions = await getUserPermissions(user.id);
    const hasAccess = await hasAnyPermission(user.id);

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        permissions,
        hasAccess, // false if all features are locked
        isImpersonation: session.isImpersonation,
        impersonatedBy: session.impersonatedBy,
        realUserEmail: session.realUserEmail,
      },
    });
  } catch (error) {
    return apiServerError(error, "Auth/Me");
  }
}
