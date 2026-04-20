/**
 * Session Management Module
 *
 * Handles session creation, validation, and revocation.
 * Implements single-device policy with admin impersonation exception.
 */

import { db, users, sessions, type Session } from "../db";
import { eq, and, lt } from "drizzle-orm";
import { signJwt, verifyJwt, type AuthJwtPayload } from "../jwt";
import { logActivity } from "../activity";
import type { GeoLocation } from "../geo";

// ============================================
// Types
// ============================================

export interface CreateSessionOptions {
  deviceInfo?: string;
  ipAddress?: string;
  geoLocation?: GeoLocation | null;
  isImpersonation?: boolean;
  impersonatedBy?: string;
  realUserEmail?: string;
}

export interface ValidatedSession {
  userId: string;
  email: string;
  role: "admin" | "user";
  sessionId: string;
  isImpersonation: boolean;
  impersonatedBy?: string;
  realUserEmail?: string;
}

// ============================================
// Session Duration
// ============================================

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================
// Functions
// ============================================

/**
 * Create a new session for a user
 */
export async function createSession(
  userId: string,
  options: CreateSessionOptions = {},
): Promise<{ token: string; sessionId: string }> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  if (!user) {
    throw new Error("User not found");
  }

  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  // Single-device policy: Revoke previous session
  // EXCEPTION: Don't revoke if this is an impersonation session
  if (!options.isImpersonation && user.currentSessionId) {
    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(eq(sessions.id, user.currentSessionId));
  }

  // Create new session record
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    deviceInfo: options.deviceInfo || null,
    ipAddress: options.ipAddress || null,
    geoLocation: options.geoLocation
      ? JSON.stringify(options.geoLocation)
      : null,
    createdAt: now,
    expiresAt,
    isImpersonation: options.isImpersonation ?? false,
    impersonatedBy: options.impersonatedBy || null,
  });

  // Update user's current session (skip for impersonation)
  if (!options.isImpersonation) {
    await db
      .update(users)
      .set({ currentSessionId: sessionId, updatedAt: now })
      .where(eq(users.id, userId));
  }

  // Sign JWT
  const token = await signJwt({
    sub: userId,
    email: user.email,
    role: user.role as "admin" | "user",
    jti: sessionId,
    impersonatedBy: options.impersonatedBy,
    realUserEmail: options.realUserEmail,
  });

  return { token, sessionId };
}

/**
 * Validate a session token
 */
export async function validateSession(
  token: string,
): Promise<ValidatedSession | null> {
  // Verify JWT
  const payload = await verifyJwt(token);
  if (!payload) {
    return null;
  }

  // Check session in database
  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, payload.jti))
    .get();

  if (!session) {
    return null;
  }

  // Check if session is revoked
  if (session.revokedAt) {
    return null;
  }

  // Check if session is expired
  if (session.expiresAt < new Date()) {
    return null;
  }

  // Check user status
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub))
    .get();

  if (!user || user.status === "suspended") {
    return null;
  }

  return {
    userId: payload.sub,
    email: payload.email,
    role: payload.role,
    sessionId: payload.jti,
    isImpersonation: session.isImpersonation ?? false,
    impersonatedBy: session.impersonatedBy ?? undefined,
    realUserEmail: payload.realUserEmail,
  };
}

/**
 * Revoke a session
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/**
 * Revoke all sessions for a user
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.revokedAt, null as unknown as Date),
      ),
    );

  await db
    .update(users)
    .set({ currentSessionId: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Get active session for a user
 */
export async function getActiveSession(
  userId: string,
): Promise<Session | null> {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();

  if (!user?.currentSessionId) {
    return null;
  }

  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, user.currentSessionId))
    .get();

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return null;
  }

  return session;
}

/**
 * Get all sessions for a user (including revoked/expired)
 */
export async function getUserSessions(
  userId: string,
  options?: { activeOnly?: boolean; limit?: number },
): Promise<Session[]> {
  let query = db.select().from(sessions).where(eq(sessions.userId, userId));

  const allSessions = await query;

  let result = allSessions;

  if (options?.activeOnly) {
    const now = new Date();
    result = allSessions.filter((s) => !s.revokedAt && s.expiresAt > now);
  }

  if (options?.limit) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/**
 * Clean up expired sessions (run periodically)
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const now = new Date();

  // Get expired sessions that haven't been revoked
  const expiredSessions = await db
    .select()
    .from(sessions)
    .where(
      and(
        lt(sessions.expiresAt, now),
        eq(sessions.revokedAt, null as unknown as Date),
      ),
    );

  // Revoke them
  for (const session of expiredSessions) {
    await db
      .update(sessions)
      .set({ revokedAt: now })
      .where(eq(sessions.id, session.id));
  }

  return expiredSessions.length;
}
