/**
 * Next.js Proxy
 *
 * Handles authentication and route protection.
 * Runs on Edge Runtime (using jose for JWT).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

// ============================================
// Configuration
// ============================================

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "dev-secret-change-in-production-32chars",
);

// Public routes that don't require auth
const PUBLIC_ROUTES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/setup-password",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/setup-password",
  "/api/health", // Health check for deployment/load balancers
];

// Auth pages that logged-in users should be redirected away from
const AUTH_PAGES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  // Note: setup-password is NOT included - users with invite links should be able to access it
];

// Routes that require admin access
const ADMIN_ROUTES = ["/api/auth/invite", "/api/auth/admin"];

// ============================================
// Middleware
// ============================================

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Allow static files and Next.js internals
  if (
    path.startsWith("/_next") ||
    path.startsWith("/favicon") ||
    path.includes(".")
  ) {
    return NextResponse.next();
  }

  // Dev-mode auth bypass: inject synthetic admin user, skip all JWT checks.
  if (process.env.NODE_ENV === "development") {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", "dev-user");
    requestHeaders.set("x-user-email", "dev@local");
    requestHeaders.set("x-user-role", "admin");
    requestHeaders.set("x-session-id", "dev-session");
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Get token from cookie
  const token = request.cookies.get("auth_token")?.value;

  // Check if this is an auth page (login, forgot-password, reset-password)
  const isAuthPage = AUTH_PAGES.some(
    (route) => path === route || path.startsWith(route + "/"),
  );

  // If user has a token and is trying to access an auth page, verify and redirect
  if (token && isAuthPage) {
    try {
      await jwtVerify(token, JWT_SECRET);
      // Token is valid - redirect to dashboard
      return NextResponse.redirect(new URL("/dashboard", request.url));
    } catch {
      // Token is invalid - clear it and continue to auth page
      const response = NextResponse.next();
      response.cookies.delete("auth_token");
      return response;
    }
  }

  // Allow public routes (for unauthenticated users)
  if (PUBLIC_ROUTES.some((route) => path.startsWith(route))) {
    return NextResponse.next();
  }

  // From here on, routes require authentication

  if (!token) {
    // Redirect to login for pages, 401 for API
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Verify JWT
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);

    // Check admin routes
    // Exception: Allow stop-impersonate for impersonating sessions
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

    // Attach user info to request headers for downstream use
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
    // Invalid or expired token
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Session expired" },
        { status: 401 },
      );
    }

    // Clear cookie and redirect to login
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.delete("auth_token");
    return response;
  }
}

// ============================================
// Matcher Configuration
// ============================================

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
