/**
 * Auth Middleware Helpers
 *
 * Utilities for use in API routes and Server Components.
 */

import { headers, cookies } from "next/headers";
import { db, users } from "../db";
import { eq } from "drizzle-orm";
import { validateSession, type ValidatedSession } from "../session";
import { getUserPermissions, hasPermission } from "../features/permissions";
import { FEATURE_IDS } from "../features/registry";

// ============================================
// Types
// ============================================

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "pending" | "active" | "suspended";
  isImpersonation: boolean;
  impersonatedBy?: string;
  realUserEmail?: string;
  permissions: Record<string, boolean>;
}

// ============================================
// Session Helpers
// ============================================

const DEV_BYPASS = process.env.NODE_ENV === "development";

const devSession = (): ValidatedSession => ({
  userId: "dev-user",
  email: "dev@local",
  role: "admin",
  sessionId: "dev-session",
  isImpersonation: false,
});

export const devPermissions = (): Record<string, boolean> =>
  Object.fromEntries(FEATURE_IDS.map((id) => [id, true]));

const devUser = (): CurrentUser => ({
  id: "dev-user",
  email: "dev@local",
  displayName: "Dev User",
  role: "admin",
  status: "active",
  isImpersonation: false,
  permissions: devPermissions(),
});

/**
 * Get current session from request
 */
export async function getSession(): Promise<ValidatedSession | null> {
  if (DEV_BYPASS) return devSession();

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;

  if (!token) {
    return null;
  }

  return validateSession(token);
}

/**
 * Get current user with full details
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (DEV_BYPASS) return devUser();

  const session = await getSession();

  if (!session) {
    return null;
  }

  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  if (!user) {
    return null;
  }

  const permissions = await getUserPermissions(user.id);

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as "admin" | "user",
    status: user.status as "pending" | "active" | "suspended",
    isImpersonation: session.isImpersonation,
    impersonatedBy: session.impersonatedBy,
    realUserEmail: session.realUserEmail,
    permissions,
  };
}

/**
 * Get current user ID from request headers (set by middleware)
 */
export async function getCurrentUserId(): Promise<string | null> {
  const headersList = await headers();
  return headersList.get("x-user-id");
}

/**
 * Get current user role from request headers (set by middleware)
 */
export async function getCurrentUserRole(): Promise<"admin" | "user" | null> {
  const headersList = await headers();
  const role = headersList.get("x-user-role");
  return role as "admin" | "user" | null;
}

/**
 * Check if current user is admin
 */
export async function isAdmin(): Promise<boolean> {
  const role = await getCurrentUserRole();
  return role === "admin";
}

/**
 * Check if current user is impersonating
 */
export async function isImpersonating(): Promise<boolean> {
  const headersList = await headers();
  return headersList.has("x-impersonated-by");
}

// ============================================
// Permission Helpers
// ============================================

/**
 * Check if current user has a permission
 */
export async function currentUserHasPermission(
  featureId: string,
): Promise<boolean> {
  const userId = await getCurrentUserId();

  if (!userId) {
    return false;
  }

  return hasPermission(userId, featureId);
}

/**
 * Require a permission (throws if not granted)
 */
export async function requirePermission(featureId: string): Promise<void> {
  const hasAccess = await currentUserHasPermission(featureId);

  if (!hasAccess) {
    throw new Error(`Permission denied: ${featureId}`);
  }
}

/**
 * Require admin role (throws if not admin)
 */
export async function requireAdmin(): Promise<void> {
  const admin = await isAdmin();

  if (!admin) {
    throw new Error("Admin access required");
  }
}

// ============================================
// Request Info Helpers
// ============================================

/**
 * Get client IP from request
 */
export async function getClientIp(): Promise<string> {
  const headersList = await headers();

  // Try various headers in order of preference
  const forwarded = headersList.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = headersList.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

/**
 * Get user agent from request
 */
export async function getUserAgent(): Promise<string | null> {
  const headersList = await headers();
  return headersList.get("user-agent");
}
