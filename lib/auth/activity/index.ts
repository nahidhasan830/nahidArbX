/**
 * Activity Logging Module
 *
 * Logs all auth-related events for audit trail.
 * Activity logs are retained by the shared 7-day log-retention scheduler.
 */

import { db, activityLogs } from "../db";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import type { GeoLocation } from "../geo";

// ============================================
// Types
// ============================================

export type ActivityAction =
  | "login"
  | "logout"
  | "login_failed"
  | "password_change"
  | "password_reset_request"
  | "password_reset_complete"
  | "invite_sent"
  | "invite_accepted"
  | "account_suspended"
  | "account_activated"
  | "account_deleted"
  | "permissions_updated"
  | "impersonation_started"
  | "impersonation_ended"
  | "force_logout";

export interface LogActivityParams {
  userId: string;
  userEmail: string;
  action: ActivityAction;
  ipAddress?: string;
  geoLocation?: GeoLocation | null;
  deviceInfo?: string;
  metadata?: Record<string, unknown>;
  performedBy?: string; // Admin user ID if action was performed by admin
}

export interface ActivityLogEntry {
  id: string;
  userId: string;
  userEmail: string;
  action: string;
  ipAddress: string | null;
  geoLocation: GeoLocation | null;
  deviceInfo: string | null;
  metadata: Record<string, unknown> | null;
  performedBy: string | null;
  createdAt: Date;
}

// ============================================
// Functions
// ============================================

/**
 * Log an activity event
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  const id = crypto.randomUUID();

  await db.insert(activityLogs).values({
    id,
    userId: params.userId,
    userEmail: params.userEmail,
    action: params.action,
    ipAddress: params.ipAddress || null,
    geoLocation: params.geoLocation ? JSON.stringify(params.geoLocation) : null,
    deviceInfo: params.deviceInfo || null,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    performedBy: params.performedBy || null,
    createdAt: new Date(),
  });
}

/**
 * Get activity logs for a user
 */
export async function getUserActivityLogs(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    excludeImpersonation?: boolean; // Hide impersonation logs from user's view
  },
): Promise<ActivityLogEntry[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const query = db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.userId, userId))
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit)
    .offset(offset);

  const logs = await query;

  return logs
    .filter((log) => {
      // If excludeImpersonation is true, filter out impersonation logs
      if (options?.excludeImpersonation) {
        return (
          log.action !== "impersonation_started" &&
          log.action !== "impersonation_ended"
        );
      }
      return true;
    })
    .map(parseActivityLog);
}

/**
 * Get all activity logs (admin view)
 */
export async function getAllActivityLogs(options?: {
  limit?: number;
  offset?: number;
  userId?: string;
  action?: ActivityAction;
  startDate?: Date;
  endDate?: Date;
}): Promise<ActivityLogEntry[]> {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const conditions = [];

  if (options?.userId) {
    conditions.push(eq(activityLogs.userId, options.userId));
  }

  if (options?.action) {
    conditions.push(eq(activityLogs.action, options.action));
  }

  if (options?.startDate) {
    conditions.push(gte(activityLogs.createdAt, options.startDate));
  }

  if (options?.endDate) {
    conditions.push(lte(activityLogs.createdAt, options.endDate));
  }

  const logs = await db
    .select()
    .from(activityLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return logs.map(parseActivityLog);
}

/**
 * Parse activity log from database format
 */
function parseActivityLog(
  log: typeof activityLogs.$inferSelect,
): ActivityLogEntry {
  return {
    id: log.id,
    userId: log.userId,
    userEmail: log.userEmail,
    action: log.action,
    ipAddress: log.ipAddress,
    geoLocation: log.geoLocation ? JSON.parse(log.geoLocation) : null,
    deviceInfo: log.deviceInfo,
    metadata: log.metadata ? JSON.parse(log.metadata) : null,
    performedBy: log.performedBy,
    createdAt: log.createdAt,
  };
}

/**
 * Get activity summary for a user (for dashboard)
 */
export async function getUserActivitySummary(userId: string): Promise<{
  totalLogins: number;
  lastLogin: Date | null;
  lastLoginIp: string | null;
  lastLoginDevice: string | null;
  lastLoginLocation: GeoLocation | null;
}> {
  const loginLogs = await db
    .select()
    .from(activityLogs)
    .where(
      and(eq(activityLogs.userId, userId), eq(activityLogs.action, "login")),
    )
    .orderBy(desc(activityLogs.createdAt))
    .limit(1);

  const countResult = await db
    .select()
    .from(activityLogs)
    .where(
      and(eq(activityLogs.userId, userId), eq(activityLogs.action, "login")),
    );

  const lastLogin = loginLogs[0];

  return {
    totalLogins: countResult.length,
    lastLogin: lastLogin?.createdAt || null,
    lastLoginIp: lastLogin?.ipAddress || null,
    lastLoginDevice: lastLogin?.deviceInfo || null,
    lastLoginLocation: lastLogin?.geoLocation
      ? JSON.parse(lastLogin.geoLocation)
      : null,
  };
}
