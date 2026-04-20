/**
 * Auth Database Schema
 *
 * Using Drizzle ORM with better-sqlite3 for type-safe auth persistence.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ============================================
// Users Table
// ============================================

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  status: text("status", { enum: ["pending", "active", "suspended"] })
    .notNull()
    .default("pending"),
  currentSessionId: text("current_session_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ============================================
// Sessions Table
// ============================================

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceInfo: text("device_info"),
  ipAddress: text("ip_address"),
  geoLocation: text("geo_location"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  isImpersonation: integer("is_impersonation", { mode: "boolean" }).default(
    false,
  ),
  impersonatedBy: text("impersonated_by"),
});

// ============================================
// Invites Table
// ============================================

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// ============================================
// Password Resets Table
// ============================================

export const passwordResets = sqliteTable("password_resets", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// ============================================
// Activity Logs Table (audit trail - never deleted)
// ============================================

export const activityLogs = sqliteTable("activity_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  action: text("action").notNull(),
  ipAddress: text("ip_address"),
  geoLocation: text("geo_location"),
  deviceInfo: text("device_info"),
  metadata: text("metadata"),
  performedBy: text("performed_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// ============================================
// User Permissions Table (per-user feature toggles)
// ============================================

export const userPermissions = sqliteTable("user_permissions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  featureId: text("feature_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// ============================================
// Type Exports
// ============================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type PasswordReset = typeof passwordResets.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type UserPermission = typeof userPermissions.$inferSelect;
