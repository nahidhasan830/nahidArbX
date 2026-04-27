"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

// ============================================
// Types
// ============================================

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "pending" | "active" | "suspended";
  permissions: Record<string, boolean>;
  hasAccess: boolean;
  isImpersonation?: boolean;
  impersonatedBy?: string;
  realUserEmail?: string;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isImpersonating: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (featureId: string) => boolean;
  refreshUser: () => Promise<void>;
}

// ============================================
// Context
// ============================================

const AuthContext = createContext<AuthContextValue | null>(null);

// ============================================
// Provider
// ============================================

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch current user
  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");

      if (!res.ok) {
        setUser(null);
        return;
      }

      const data = await res.json();
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    let isMounted = true;
    const init = async () => {
      await fetchUser();
      if (isMounted) setIsLoading(false);
    };
    init();
    return () => {
      isMounted = false;
    };
  }, [fetchUser]);

  // Heartbeat to update last activity and detect session revocation (every 30 seconds)
  useEffect(() => {
    if (!user) return;

    const checkSession = async () => {
      try {
        const res = await fetch("/api/auth/heartbeat", { method: "POST" });

        // Session was revoked (logged in from another device)
        if (res.status === 401) {
          setUser(null);
          router.push("/login?reason=session_revoked");
          router.refresh();
        }
      } catch {
        // Network error - ignore
      }
    };

    // Check every 30 seconds for faster session revocation detection
    const interval = setInterval(checkSession, 30 * 1000);

    // Initial heartbeat
    checkSession();

    return () => clearInterval(interval);
  }, [user, router]);

  // Login
  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    setUser(data.user);
    router.push("/dashboard");
    router.refresh();
  };

  // Logout
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    router.push("/login");
    router.refresh();
  };

  // Permission gate removed — all authenticated users have full access.
  // Re-enable per-feature gating here if needed in the future.
  const hasPermission = (_featureId: string): boolean => {
    return !!user;
  };

  // Refresh user data
  const refreshUser = async () => {
    await fetchUser();
  };

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: !!user,
    isAdmin: user?.role === "admin",
    isImpersonating: user?.isImpersonation ?? false,
    login,
    logout,
    hasPermission,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ============================================
// Hook
// ============================================

// Default value for when context is not available (e.g., during SSG)
const defaultAuthValue: AuthContextValue = {
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isAdmin: false,
  isImpersonating: false,
  login: async () => {
    throw new Error("Auth not initialized");
  },
  logout: async () => {
    throw new Error("Auth not initialized");
  },
  hasPermission: () => false,
  refreshUser: async () => {},
};

export function useAuth() {
  const context = useContext(AuthContext);

  // Return default value if context is not available
  // This can happen during SSG or when used outside provider
  if (!context) {
    return defaultAuthValue;
  }

  return context;
}

// ============================================
// Permission-based rendering components
// ============================================

// ============================================
// useFeature Hook - Easy permission checking
// ============================================

import type { FeatureId } from "@/lib/auth/features/registry";

interface UseFeatureResult {
  /** Whether the user has permission for this feature */
  enabled: boolean;
  /** Whether auth is still loading */
  loading: boolean;
  /** Whether the user is authenticated */
  authenticated: boolean;
}

/**
 * Hook to check if a feature is enabled for the current user.
 *
 * Usage:
 * ```tsx
 * const { enabled } = useFeature("sync-all");
 * if (!enabled) return null;
 * ```
 *
 * Or with loading state:
 * ```tsx
 * const { enabled, loading } = useFeature("export-data");
 * if (loading) return <Skeleton />;
 * if (!enabled) return <UpgradePrompt />;
 * ```
 */
export function useFeature(featureId: FeatureId | string): UseFeatureResult {
  const { hasPermission, isLoading, isAuthenticated } = useAuth();

  return {
    enabled: hasPermission(featureId),
    loading: isLoading,
    authenticated: isAuthenticated,
  };
}

/**
 * Hook to check multiple features at once.
 *
 * Usage:
 * ```tsx
 * const features = useFeatures(["sync-all", "export-data", "copy-odds"]);
 * if (features["sync-all"]) { ... }
 * ```
 */
export function useFeatures(
  featureIds: (FeatureId | string)[],
): Record<string, boolean> {
  const { hasPermission } = useAuth();

  const result: Record<string, boolean> = {};
  for (const id of featureIds) {
    result[id] = hasPermission(id);
  }
  return result;
}

// ============================================
// Feature Component - Declarative permission rendering
// ============================================

interface FeatureProps {
  /** Feature ID to check permission for */
  id: FeatureId | string;
  /** Content to render if feature is enabled */
  children: ReactNode;
  /** Optional fallback if feature is disabled */
  fallback?: ReactNode;
  /** Optional loading state while auth loads */
  loading?: ReactNode;
}

/**
 * Declarative component to conditionally render based on feature permission.
 *
 * Usage:
 * ```tsx
 * <Feature id="sync-all">
 *   <SyncButton />
 * </Feature>
 *
 * // With fallback
 * <Feature id="export-data" fallback={<UpgradeButton />}>
 *   <ExportButton />
 * </Feature>
 * ```
 */
export function Feature({
  id,
  children,
  fallback = null,
  loading = null,
}: FeatureProps) {
  const { hasPermission, isLoading } = useAuth();

  if (isLoading) return <>{loading}</>;
  if (!hasPermission(id)) return <>{fallback}</>;

  return <>{children}</>;
}

// ============================================
// Legacy Components (kept for compatibility)
// ============================================

interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}

/** @deprecated Use `<Feature id="..." />` instead */
export function RequirePermission({
  permission,
  children,
  fallback = null,
}: RequirePermissionProps) {
  const { hasPermission, isLoading } = useAuth();

  if (isLoading) return null;
  if (!hasPermission(permission)) return <>{fallback}</>;

  return <>{children}</>;
}

interface RequireAdminProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequireAdmin({ children, fallback = null }: RequireAdminProps) {
  const { isAdmin, isLoading } = useAuth();

  if (isLoading) return null;
  if (!isAdmin) return <>{fallback}</>;

  return <>{children}</>;
}
