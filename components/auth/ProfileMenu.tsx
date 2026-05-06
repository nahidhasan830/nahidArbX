"use client";

import { useState } from "react";
import { useAuth } from "./AuthProvider";
import {
  User,
  LogOut,
  Key,
  ChevronsUpDown,
  Users,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ProfileMenuProps {
  onOpenUserManagement?: () => void;
}

export function ProfileMenu({ onOpenUserManagement }: ProfileMenuProps) {
  const { user, logout, isAdmin, isImpersonating, refreshUser } = useAuth();
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);

  const handleLogout = async () => {
    await logout();
  };

  const handleStopImpersonating = async () => {
    try {
      const res = await fetch("/api/auth/admin/stop-impersonate", {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error("❌ Couldn't stop impersonation", {
          description: data.error || undefined,
        });
        return;
      }

      window.location.reload();
    } catch (err) {
      toast.error("❌ Couldn't stop impersonation", {
        description: "Network error — please try again",
      });
      console.error("Stop impersonation error:", err);
    }
  };

  if (!user) return null;

  const displayName = user.displayName || user.email.split("@")[0];

  return (
    <>
      {/* Impersonation Banner - Fixed at top of screen */}
      {isImpersonating && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-yellow-500/90 px-4 py-2 flex items-center justify-center gap-3 shadow-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-900" />
          <span className="text-sm font-medium text-yellow-900">
            You are viewing as <strong>{user.email}</strong>
          </span>
          <button
            onClick={handleStopImpersonating}
            className="px-3 py-1 text-sm font-medium bg-yellow-900 text-yellow-100 rounded hover:bg-yellow-800 transition"
          >
            Back to Admin
          </button>
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            tooltip={user.displayName || user.email}
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <div className="flex size-8 items-center justify-center rounded-md bg-gradient-to-br from-cyan-500 to-blue-500 shrink-0">
              <User className="size-4 text-white" />
            </div>
            <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-medium">
                {displayName}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {user.email}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4 opacity-60 group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="end"
          sideOffset={12}
          className="w-60 rounded-lg"
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-2 py-1.5 text-left text-sm">
              <div className="flex size-8 items-center justify-center rounded-md bg-gradient-to-br from-cyan-500 to-blue-500 shrink-0">
                <User className="size-4 text-white" />
              </div>
              <div className="grid flex-1 leading-tight">
                <span className="truncate text-sm font-medium">
                  {displayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {isAdmin && onOpenUserManagement && (
            <DropdownMenuItem onSelect={() => onOpenUserManagement()}>
              <Users className="size-4" />
              User Management
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setIsEditingProfile(true)}>
            <Pencil className="size-4" />
            Edit Profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsChangingPassword(true)}>
            <Key className="size-4" />
            Change Password
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleLogout} variant="destructive">
            <LogOut className="size-4" />
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Change Password Modal */}
      {isChangingPassword && (
        <ChangePasswordModal onClose={() => setIsChangingPassword(false)} />
      )}

      {/* Edit Profile Modal */}
      {isEditingProfile && (
        <EditProfileModal
          currentDisplayName={user.displayName}
          onClose={() => setIsEditingProfile(false)}
          onSave={() => {
            setIsEditingProfile(false);
            refreshUser();
          }}
        />
      )}
    </>
  );
}

// ============================================
// Change Password Modal
// ============================================

function EditProfileModal({
  currentDisplayName,
  onClose,
  onSave,
}: {
  currentDisplayName: string | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const [displayName, setDisplayName] = useState(currentDisplayName || "");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError("Display name is required");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: displayName.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to update profile");
      }

      onSave();
      toast.success("✏️ Profile updated", {
        description: `Display name set to "${displayName.trim()}"`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile");
      toast.error("❌ Profile update failed", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-slate-900 rounded-xl shadow-xl border border-slate-800 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Edit Profile</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              placeholder="Enter your display name"
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              This name will be shown throughout the app
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 px-4 rounded-lg border border-slate-600 text-gray-300 hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 py-2.5 px-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition disabled:opacity-50"
            >
              {isLoading ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================
// Change Password Modal
// ============================================

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to change password");
      }

      setSuccess(true);
      toast.success("🔒 Password changed");
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to change password",
      );
      toast.error("❌ Password change failed", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-slate-900 rounded-xl shadow-xl border border-slate-800 p-6">
        <h3 className="text-lg font-semibold text-white mb-4">
          Change Password
        </h3>

        {success ? (
          <div className="text-center py-4">
            <div className="text-green-400 mb-2">
              Password changed successfully!
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Current Password
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                New Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Min 8 chars, 1 uppercase, 1 lowercase, 1 number
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Confirm New Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 px-4 rounded-lg border border-slate-600 text-gray-300 hover:bg-slate-800 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="flex-1 py-2.5 px-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition disabled:opacity-50"
              >
                {isLoading ? "Saving..." : "Change Password"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
