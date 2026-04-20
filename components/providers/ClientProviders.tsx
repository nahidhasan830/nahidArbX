"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

// ============================================
// Auth Types (inline to avoid import issues)
// ============================================

interface User {
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
// Auth Context
// ============================================

const AuthContext = createContext<AuthContextValue | null>(null);

function InternalAuthProvider({ children }: { children: ReactNode }) {
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
    fetchUser().finally(() => setIsLoading(false));
  }, [fetchUser]);

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(
      () => {
        fetch("/api/auth/heartbeat", { method: "POST" }).catch(() => {});
      },
      2 * 60 * 1000,
    );
    fetch("/api/auth/heartbeat", { method: "POST" }).catch(() => {});
    return () => clearInterval(interval);
  }, [user]);

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

  const hasPermission = (featureId: string): boolean => {
    if (!user) return false;
    if (user.role === "admin") return true;
    return user.permissions[featureId] ?? false;
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

// ============================================
// Exports
// ============================================

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

// ============================================
// Client Providers
// ============================================

interface ClientProvidersProps {
  children: ReactNode;
}

export function ClientProviders({ children }: ClientProvidersProps) {
  // Temporarily bypass auth provider to debug build issue
  return <>{children}</>;
}
