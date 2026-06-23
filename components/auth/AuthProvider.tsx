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


const AuthContext = createContext<AuthContextValue | null>(null);


interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  useEffect(() => {
    if (!user) return;

    const checkSession = async () => {
      try {
        const res = await fetch("/api/auth/heartbeat", { method: "POST" });

        if (res.status === 401) {
          setUser(null);
          router.push("/login?reason=session_revoked");
          router.refresh();
        }
      } catch {
      }
    };

    const interval = setInterval(checkSession, 30 * 1000);

    checkSession();

    return () => clearInterval(interval);
  }, [user, router]);

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

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    router.push("/login");
    router.refresh();
  };

  const hasPermission = (_featureId: string): boolean => {
    return !!user;
  };

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

  if (!context) {
    return defaultAuthValue;
  }

  return context;
}


import type { FeatureId } from "@/lib/auth/features/registry";

interface UseFeatureResult {
  enabled: boolean;
  loading: boolean;
  authenticated: boolean;
}

export function useFeature(featureId: FeatureId | string): UseFeatureResult {
  const { hasPermission, isLoading, isAuthenticated } = useAuth();

  return {
    enabled: hasPermission(featureId),
    loading: isLoading,
    authenticated: isAuthenticated,
  };
}

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


interface FeatureProps {
  id: FeatureId | string;
  children: ReactNode;
  fallback?: ReactNode;
  loading?: ReactNode;
}

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


interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}

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
