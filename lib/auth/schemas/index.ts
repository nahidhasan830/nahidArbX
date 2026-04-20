/**
 * Auth Zod Schemas
 *
 * Validation schemas for all auth-related requests.
 */

import { z } from "zod";

// ============================================
// Login
// ============================================

export const LoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginSchema>;

// ============================================
// Password Setup (after invite)
// ============================================

export const SetupPasswordSchema = z
  .object({
    token: z.string().min(1, "Token is required"),
    displayName: z
      .string()
      .max(100, "Display name too long")
      .nullable()
      .optional(),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SetupPasswordInput = z.infer<typeof SetupPasswordSchema>;

// ============================================
// Change Password
// ============================================

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

// ============================================
// Forgot Password
// ============================================

export const ForgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

// ============================================
// Reset Password
// ============================================

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, "Token is required"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// ============================================
// Invite User
// ============================================

export const InviteUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  displayName: z.string().optional(),
});

export type InviteUserInput = z.infer<typeof InviteUserSchema>;

// ============================================
// Update User (admin)
// ============================================

export const UpdateUserSchema = z.object({
  displayName: z.string().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

// ============================================
// Update Permissions (admin)
// ============================================

export const UpdatePermissionsSchema = z.object({
  permissions: z.record(z.string(), z.boolean()),
});

export type UpdatePermissionsInput = z.infer<typeof UpdatePermissionsSchema>;

// ============================================
// Impersonate User (admin)
// ============================================

export const ImpersonateSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});

export type ImpersonateInput = z.infer<typeof ImpersonateSchema>;
