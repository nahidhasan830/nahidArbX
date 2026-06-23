

export {
  getPinnacleToken,
  isTokenValid,
  getStoredToken,
  closeBrowser,
} from "./token-manager";

export type { TokenData } from "./token-manager";


export { db } from "./db";
export type {
  User,
  NewUser,
  Session,
  Invite,
  PasswordReset,
  ActivityLog,
  UserPermission,
} from "./db/schema";


export { signJwt, verifyJwt, decodeJwt } from "./jwt";
export type { AuthJwtPayload } from "./jwt";


export {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from "./password";


export {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  getActiveSession,
  getUserSessions,
  cleanupExpiredSessions,
} from "./session";
export type { ValidatedSession, CreateSessionOptions } from "./session";


export { getGeoLocation, parseDeviceInfo } from "./geo";
export type { GeoLocation } from "./geo";


export {
  logActivity,
  getUserActivityLogs,
  getAllActivityLogs,
  getUserActivitySummary,
} from "./activity";
export type {
  ActivityAction,
  LogActivityParams,
  ActivityLogEntry,
} from "./activity";


export {
  FEATURE_REGISTRY,
  FEATURE_IDS,
  getFeature,
  getFeatureDisplayName,
  isAdminOnlyFeature,
  getFeatureDefaultEnabled,
  getFeaturesByCategory,
  getUserAssignableFeatures,
} from "./features/registry";
export type { FeatureId, FeatureMetadata } from "./features/registry";

export {
  getUserPermissions,
  hasPermission,
  setPermission,
  setPermissions,
  initializeUserPermissions,
  hasAnyPermission,
  grantDefaultPermissions,
  grantAllPermissions,
  revokeAllPermissions,
} from "./features/permissions";
export type { UserPermissions } from "./features/permissions";


export { sendInviteEmail, sendPasswordResetEmail } from "./email";


export {
  getSession,
  getCurrentUser,
  getCurrentUserId,
  getCurrentUserRole,
  isAdmin,
  isImpersonating,
  currentUserHasPermission,
  requirePermission,
  requireAdmin,
  getClientIp,
  getUserAgent,
} from "./middleware/auth";
export type { CurrentUser } from "./middleware/auth";


export {
  initializeAuth,
  initializeDatabase,
  bootstrapAdmin,
} from "./bootstrap";


export {
  LoginSchema,
  SetupPasswordSchema,
  ChangePasswordSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  InviteUserSchema,
  UpdateUserSchema,
  UpdatePermissionsSchema,
  ImpersonateSchema,
} from "./schemas";
export type {
  LoginInput,
  SetupPasswordInput,
  ChangePasswordInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  InviteUserInput,
  UpdateUserInput,
  UpdatePermissionsInput,
  ImpersonateInput,
} from "./schemas";


export {
  RATE_LIMIT_CONFIGS,
  createRateLimitKey,
  checkRateLimit,
  resetRateLimit,
  getRemainingAttempts,
  cleanupRateLimitStore,
  rateLimitResponse,
} from "./rate-limit";
