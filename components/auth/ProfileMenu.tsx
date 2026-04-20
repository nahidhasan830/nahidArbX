"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import {
  User,
  LogOut,
  Key,
  ChevronDown,
  Users,
  AlertTriangle,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";

interface ProfileMenuProps {
  onOpenUserManagement?: () => void;
}

export function ProfileMenu({ onOpenUserManagement }: ProfileMenuProps) {
  const { user, logout, isAdmin, isImpersonating, refreshUser } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
        toast.error("Couldn't stop impersonation", {
          description: data.error || undefined,
        });
        return;
      }

      window.location.reload();
    } catch (err) {
      toast.error("Couldn't stop impersonation", {
        description: "Network error — please try again",
      });
      console.error("Stop impersonation error:", err);
    }
  };

  if (!user) return null;

  return (
    <div className="relative" ref={menuRef}>
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

      {/* Profile Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 transition"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center">
          <User className="w-4 h-4 text-white" />
        </div>
        <div className="hidden sm:block text-left">
          <div className="text-sm font-medium text-white">
            {user.displayName || user.email.split("@")[0]}
          </div>
          <div className="text-xs text-gray-400">
            {isAdmin ? "Admin" : "User"}
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 transition ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 bg-slate-800 rounded-lg shadow-xl border border-slate-700 py-1 z-50">
          {/* User info */}
          <div className="px-4 py-3 border-b border-slate-700">
            <div className="text-sm font-medium text-white truncate">
              {user.displayName || user.email}
            </div>
            <div className="text-xs text-gray-400 truncate">{user.email}</div>
          </div>

          {/* Admin: User Management */}
          {isAdmin && onOpenUserManagement && (
            <button
              onClick={() => {
                setIsOpen(false);
                onOpenUserManagement();
              }}
              className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2 transition"
            >
              <Users className="w-4 h-4" />
              User Management
            </button>
          )}

          {/* Edit Profile */}
          <button
            onClick={() => {
              setIsOpen(false);
              setIsEditingProfile(true);
            }}
            className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2 transition"
          >
            <Pencil className="w-4 h-4" />
            Edit Profile
          </button>

          {/* Change Password */}
          <button
            onClick={() => {
              setIsOpen(false);
              setIsChangingPassword(true);
            }}
            className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-slate-700 hover:text-white flex items-center gap-2 transition"
          >
            <Key className="w-4 h-4" />
            Change Password
          </button>

          {/* Logout */}
          <button
            onClick={handleLogout}
            className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      )}

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
    </div>
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile");
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
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to change password",
      );
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
