import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-secret-change-in-production-32chars",
);

const PUBLIC_ROUTES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/setup-password",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/setup-password",
  "/api/health",
];

const AUTH_PAGES = [
  "/login",
  "/forgot-password",
  "/reset-password",
];

const ADMIN_ROUTES = ["/api/auth/invite", "/api/auth/admin"];

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (
    path.startsWith("/_next") ||
    path.startsWith("/favicon") ||
    path.includes(".")
  ) {
    return NextResponse.next();
  }

  if (process.env.NODE_ENV === "development") {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", "dev-user");
    requestHeaders.set("x-user-email", "dev@local");
    requestHeaders.set("x-user-role", "admin");
    requestHeaders.set("x-session-id", "dev-session");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const token = request.cookies.get("auth_token")?.value;

  const isAuthPage = AUTH_PAGES.some(
    (route) => path === route || path.startsWith(route + "/"),
  );

  if (token && isAuthPage) {
    try {
      await jwtVerify(token, JWT_SECRET);
      return NextResponse.redirect(new URL("/dashboard", request.url));
    } catch {
      const response = NextResponse.next();
      response.cookies.delete("auth_token");
      return response;
    }
  }

  if (PUBLIC_ROUTES.some((route) => path.startsWith(route))) {
    return NextResponse.next();
  }

  if (!token) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);

    const isStopImpersonate = path === "/api/auth/admin/stop-impersonate";
    const canAccessAdminRoute =
      payload.role === "admin" || (isStopImpersonate && payload.impersonatedBy);

    if (
      ADMIN_ROUTES.some((route) => path.startsWith(route)) &&
      !canAccessAdminRoute
    ) {
      if (path.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Forbidden" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", payload.sub as string);
    requestHeaders.set("x-user-email", payload.email as string);
    requestHeaders.set("x-user-role", payload.role as string);
    requestHeaders.set("x-session-id", payload.jti as string);

    if (payload.impersonatedBy) {
      requestHeaders.set("x-impersonated-by", payload.impersonatedBy as string);
    }

    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  } catch {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Session expired" },
        { status: 401 },
      );
    }

    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("auth_token");
    return response;
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
