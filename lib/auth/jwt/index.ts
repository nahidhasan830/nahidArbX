/**
 * JWT Module
 *
 * Using jose for Edge Runtime compatibility (works in Next.js middleware).
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// ============================================
// Types
// ============================================

export interface AuthJwtPayload extends JWTPayload {
  sub: string; // User ID
  email: string;
  role: "admin" | "user";
  jti: string; // Session ID (for revocation)
  impersonatedBy?: string; // Admin user ID if impersonating
  realUserEmail?: string; // Admin email if impersonating
}

// ============================================
// Configuration
// ============================================

const JWT_SECRET_KEY =
  process.env.JWT_SECRET || "dev-secret-change-in-production-32chars";
const JWT_EXPIRES_IN = "24h";

function getSecret(): Uint8Array {
  return new TextEncoder().encode(JWT_SECRET_KEY);
}

// ============================================
// Functions
// ============================================

/**
 * Sign a JWT token
 */
export async function signJwt(
  payload: Omit<AuthJwtPayload, "iat" | "exp">,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRES_IN)
    .sign(getSecret());
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJwt(token: string): Promise<AuthJwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as AuthJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT without verification (for debugging)
 */
export function decodeJwt(token: string): AuthJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload as AuthJwtPayload;
  } catch {
    return null;
  }
}
