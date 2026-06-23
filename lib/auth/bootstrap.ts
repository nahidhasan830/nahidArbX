
import { db, users, userPermissions } from "./db";
import { hashPassword } from "./password";
import { FEATURE_IDS } from "./features/registry";
import { eq } from "drizzle-orm";


export async function initializeDatabase(): Promise<void> {

  const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } })
    .$client;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      current_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_info TEXT,
      ip_address TEXT,
      geo_location TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      is_impersonation INTEGER DEFAULT 0,
      impersonated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      ip_address TEXT,
      geo_location TEXT,
      device_info TEXT,
      metadata TEXT,
      performed_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feature_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, feature_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON user_permissions(user_id);
  `);

  console.log("[Auth] Database tables initialized");
}


export async function bootstrapAdmin(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log(
      "[Auth] ADMIN_EMAIL or ADMIN_PASSWORD not set, skipping admin bootstrap",
    );
    return;
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, adminEmail.toLowerCase()))
    .get();

  if (existing) {
    const passwordHash = await hashPassword(adminPassword);
    await db
      .update(users)
      .set({
        passwordHash,
        role: "admin",
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));

    console.log("[Auth] Admin user updated:", adminEmail);
    return;
  }

  const adminId = crypto.randomUUID();
  const passwordHash = await hashPassword(adminPassword);
  const now = new Date();

  await db.insert(users).values({
    id: adminId,
    email: adminEmail.toLowerCase(),
    passwordHash,
    displayName: "Admin",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  for (const featureId of FEATURE_IDS) {
    await db.insert(userPermissions).values({
      id: crypto.randomUUID(),
      userId: adminId,
      featureId,
      enabled: true,
      updatedAt: now,
    });
  }

  console.log("[Auth] Admin user created:", adminEmail);
}


let initialized = false;

export async function initializeAuth(): Promise<void> {
  if (initialized) {
    return;
  }

  try {
    await initializeDatabase();
    await bootstrapAdmin();
    initialized = true;
    console.log("[Auth] Authentication system initialized");
  } catch (error) {
    console.error("[Auth] Failed to initialize:", error);
    throw error;
  }
}
