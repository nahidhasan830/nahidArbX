"use client";

import { useState, useEffect, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  X,
  UserPlus,
  Users,
  Activity,
  Shield,
  Eye,
  Trash2,
  RefreshCw,
  LogOut,
  Clock,
  MapPin,
  Search,
  ChevronRight,
  Info,
  Globe,
  Laptop,
  Key,
  Filter,
  LogIn,
  Zap,
  Copy,
  AlertTriangle,
  Send,
} from "lucide-react";
import { toast } from "sonner";

interface UserData {
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  status: "pending" | "active" | "suspended";
  createdAt: string;
  updatedAt: string;
  isOnline: boolean;
  currentDevice: string | null;
  permissions: Record<string, boolean>;
  activitySummary: {
    totalLogins: number;
    lastLogin: string | null;
    lastLoginIp: string | null;
    lastLoginDevice: string | null;
    lastLoginLocation: { country: string; city: string } | null;
  };
}

interface ActivityLog {
  id: string;
  action: string;
  ipAddress: string | null;
  geoLocation: { country: string; city: string } | null;
  deviceInfo: string | null;
  performedBy: string | null;
  createdAt: string;
}

interface PermissionData {
  featureId: string;
  displayName: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  adminOnly: boolean;
  enabled: boolean;
  implemented: boolean;
}

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatDate(dateStr: string): string {
  return format(parseISO(dateStr), "MMM d, yyyy");
}

function formatDateTime(dateStr: string): string {
  return format(parseISO(dateStr), "MMM d HH:mm");
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

function getActionLabel(action: string): string {
  const labels: Record<string, string> = {
    login: "Logged in",
    logout: "Logged out",
    login_failed: "Login failed",
    password_change: "Changed password",
    password_reset_request: "Requested password reset",
    password_reset_complete: "Reset password",
    invite_sent: "Invite sent",
    invite_accepted: "Accepted invite",
    account_suspended: "Account suspended",
    account_activated: "Account activated",
    account_deleted: "Account deleted",
    permissions_updated: "Permissions updated",
    impersonation_started: "Impersonation started",
    impersonation_ended: "Impersonation ended",
    force_logout: "Force logged out",
  };
  return labels[action] || action.replace(/_/g, " ");
}

function getActionColor(action: string): string {
  if (
    action === "login" ||
    action === "invite_accepted" ||
    action === "account_activated"
  )
    return "text-green-400";
  if (action === "logout" || action === "force_logout")
    return "text-orange-400";
  if (
    action === "login_failed" ||
    action === "account_suspended" ||
    action === "account_deleted"
  )
    return "text-red-400";
  if (action.includes("password")) return "text-blue-400";
  if (action.includes("impersonation")) return "text-cyan-400";
  if (action === "permissions_updated" || action === "invite_sent")
    return "text-cyan-400";
  return "text-gray-400";
}

function getActionIcon(action: string) {
  if (action === "login") return LogIn;
  if (action === "logout" || action === "force_logout") return LogOut;
  if (action === "login_failed") return X;
  if (action.includes("password")) return Key;
  if (action.includes("impersonation")) return Eye;
  if (action.includes("invite")) return UserPlus;
  if (action.includes("account") || action === "permissions_updated")
    return Shield;
  return Activity;
}

const ACTION_FILTERS = [
  { value: "all", label: "All Activity" },
  { value: "login", label: "Logins" },
  { value: "logout", label: "Logouts" },
  { value: "password", label: "Password" },
  { value: "admin", label: "Admin Actions" },
] as const;

type ActionFilter = (typeof ACTION_FILTERS)[number]["value"];

export function UserManagementModal({
  isOpen,
  onClose,
}: UserManagementModalProps) {
  const [activeTab, setActiveTab] = useState<"users" | "invite">("users");
  const [users, setUsers] = useState<UserData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [_error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<UserData | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSetupUrl, setInviteSetupUrl] = useState<string | null>(null);

  const [userToDelete, setUserToDelete] = useState<UserData | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await fetch("/api/auth/admin/users");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch users");
      }

      setUsers(data.users);
      setSelectedUser((prev) => {
        if (!prev) return null;
        const updated = data.users.find((u: UserData) => u.id === prev.id);
        return updated || null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch users");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchUsers();
    } else {
      setSelectedUser(null);
      setSearchTerm("");
    }
  }, [isOpen, fetchUsers]);

  const filteredUsers = users.filter((user) => {
    const search = searchTerm.toLowerCase();
    return (
      user.email.toLowerCase().includes(search) ||
      (user.displayName?.toLowerCase().includes(search) ?? false)
    );
  });

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteLoading(true);
    setError(null);
    setInviteSetupUrl(null);

    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to send invite");
      }

      if (data.data?.emailNotConfigured && data.data?.setupUrl) {
        setInviteSetupUrl(data.data.setupUrl);
        toast.warning("⚠️ Email not configured", {
          description: "Share the invite link manually",
        });
      } else {
        toast.success("📧 Invite sent", { description: inviteEmail });
        setInviteEmail("");
        setActiveTab("users");
      }
      fetchUsers();
    } catch (err) {
      toast.error("❌ Couldn't send invite", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setInviteLoading(false);
    }
  };

  const handleToggleStatus = async (user: UserData) => {
    const newStatus = user.status === "suspended" ? "active" : "suspended";
    const action = newStatus === "suspended" ? "Suspend" : "Activate";

    try {
      const res = await fetch(`/api/auth/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${action.toLowerCase()} user`);
      }

      toast.success(
        newStatus === "suspended" ? "⏸️ User suspended" : "✅ User activated",
        { description: user.displayName || user.email },
      );
      fetchUsers();
    } catch (err) {
      toast.error(`❌ Couldn't ${action.toLowerCase()} user`, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleDelete = (user: UserData) => {
    setUserToDelete(user);
  };

  const confirmDelete = async () => {
    if (!userToDelete) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/auth/admin/users/${userToDelete.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete user");
      }

      toast.success("🗑️ User deleted", {
        description: userToDelete.displayName || userToDelete.email,
      });
      if (selectedUser?.id === userToDelete.id) setSelectedUser(null);
      setUserToDelete(null);
      fetchUsers();
    } catch (err) {
      toast.error("❌ Couldn't delete user", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleImpersonate = async (user: UserData) => {
    try {
      const res = await fetch("/api/auth/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to impersonate");
      }

      window.location.reload();
    } catch (err) {
      toast.error("❌ Couldn't impersonate user", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleForceLogout = async (user: UserData) => {
    if (!confirm(`Force logout ${user.email}?`)) return;

    try {
      const res = await fetch(`/api/auth/admin/users/${user.id}/logout`, {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to logout user");
      }

      toast.success("🚪 User logged out", {
        description: user.displayName || user.email,
      });
      fetchUsers();
    } catch (err) {
      toast.error("❌ Couldn't log out user", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <div className="relative w-full max-w-5xl h-[85vh] bg-slate-900 rounded-xl shadow-xl border border-slate-800 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-cyan-400" />
              User Management
            </h2>
            <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
              <button
                onClick={() => setActiveTab("users")}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${
                  activeTab === "users"
                    ? "bg-cyan-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                Users
              </button>
              <button
                onClick={() => setActiveTab("invite")}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${
                  activeTab === "invite"
                    ? "bg-cyan-600 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                <UserPlus className="w-4 h-4 inline mr-1.5" />
                Invite
              </button>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-800 rounded-lg transition"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {activeTab === "users" ? (
            <>
              <div className="w-80 border-r border-slate-800 flex flex-col shrink-0">
                <div className="p-3 border-b border-slate-800">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Search users..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {isLoading ? (
                    <div className="p-4 text-center text-gray-400">
                      Loading...
                    </div>
                  ) : filteredUsers.length === 0 ? (
                    <div className="p-4 text-center text-gray-400">
                      {searchTerm ? "No users found" : "No users yet"}
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800">
                      {filteredUsers.map((user) => (
                        <button
                          key={user.id}
                          onClick={() => setSelectedUser(user)}
                          className={`w-full p-3 text-left transition flex items-center gap-3 ${
                            selectedUser?.id === user.id
                              ? "bg-slate-800"
                              : "hover:bg-slate-800/50"
                          }`}
                        >
                          <div className="relative">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center text-white font-medium">
                              {(user.displayName ||
                                user.email)[0].toUpperCase()}
                            </div>
                            <div
                              className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-900 ${
                                user.isOnline ? "bg-green-500" : "bg-gray-500"
                              }`}
                            />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white truncate">
                                {user.displayName || user.email.split("@")[0]}
                              </span>
                              {user.role === "admin" && (
                                <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500/20 text-cyan-300 rounded font-medium">
                                  ADMIN
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 truncate">
                              {user.email}
                            </div>
                          </div>

                          <div
                            className={`px-2 py-0.5 text-[10px] font-medium rounded ${
                              user.status === "active"
                                ? "bg-green-500/20 text-green-400"
                                : user.status === "suspended"
                                  ? "bg-red-500/20 text-red-400"
                                  : "bg-yellow-500/20 text-yellow-400"
                            }`}
                          >
                            {user.status}
                          </div>

                          <ChevronRight className="w-4 h-4 text-gray-600" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="p-3 border-t border-slate-800">
                  <button
                    onClick={fetchUsers}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-slate-800 rounded-lg transition"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
                    />
                    Refresh
                  </button>
                </div>
              </div>

              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedUser ? (
                  <UserDetailsPanel
                    user={selectedUser}
                    onRefresh={fetchUsers}
                    onImpersonate={handleImpersonate}
                    onForceLogout={handleForceLogout}
                    onToggleStatus={handleToggleStatus}
                    onDelete={handleDelete}
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-gray-500">
                    <div className="text-center">
                      <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>Select a user to view details</p>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="w-full max-w-md">
                {inviteSetupUrl ? (
                  <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-yellow-200 font-medium">
                            Email not configured
                          </p>
                          <p className="text-yellow-200/70 text-sm mt-1">
                            RESEND_API_KEY is not set. Share this link manually
                            with <strong>{inviteEmail}</strong>:
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-slate-800 border border-slate-700">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={inviteSetupUrl}
                          readOnly
                          className="flex-1 bg-transparent text-sm text-gray-300 font-mono outline-none"
                        />
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(inviteSetupUrl);
                            toast.success("📋 Link copied");
                          }}
                          className="p-2 hover:bg-slate-700 rounded-lg transition text-gray-400 hover:text-white"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        setInviteSetupUrl(null);
                        setInviteEmail("");
                      }}
                      className="w-full py-2.5 px-4 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-medium transition"
                    >
                      Invite Another User
                    </button>
                  </div>
                ) : (
                  <>
                    <form onSubmit={handleInvite} className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1.5">
                          Email Address
                        </label>
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          required
                          placeholder="user@example.com"
                          className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={inviteLoading}
                        className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium transition disabled:opacity-50"
                      >
                        {inviteLoading ? "Sending..." : "Send Invite"}
                      </button>
                    </form>

                    <p className="mt-4 text-sm text-gray-500 text-center">
                      The user will receive an email with a link to set up their
                      password.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {userToDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => !isDeleting && setUserToDelete(null)}
          />
          <div className="relative bg-slate-900 rounded-xl border border-slate-700 p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-full bg-red-500/20">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">
                  Delete User
                </h3>
                <p className="text-sm text-gray-400">{userToDelete.email}</p>
              </div>
            </div>

            <div className="mb-6">
              <p className="text-gray-300 mb-4">
                This will permanently delete the user and all associated data:
              </p>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-red-400" />
                  All active sessions will be terminated
                </li>
                <li className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-red-400" />
                  Activity logs and login history
                </li>
                <li className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-red-400" />
                  User permissions and settings
                </li>
                <li className="flex items-center gap-2">
                  <Key className="w-4 h-4 text-red-400" />
                  Password and authentication data
                </li>
              </ul>
            </div>

            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 mb-6">
              <p className="text-sm text-red-300">
                <strong>Warning:</strong> This action cannot be undone.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setUserToDelete(null)}
                disabled={isDeleting}
                className="flex-1 py-2.5 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="flex-1 py-2.5 px-4 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Delete User
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface UserDetailsPanelProps {
  user: UserData;
  onRefresh: () => void;
  onImpersonate: (user: UserData) => void;
  onForceLogout: (user: UserData) => void;
  onToggleStatus: (user: UserData) => void;
  onDelete: (user: UserData) => void;
}

function UserDetailsPanel({
  user,
  onRefresh,
  onImpersonate,
  onForceLogout,
  onToggleStatus,
  onDelete,
}: UserDetailsPanelProps) {
  const [activeTab, setActiveTab] = useState<
    "activity" | "sessions" | "permissions" | "info"
  >("activity");
  const [isResending, setIsResending] = useState(false);

  const handleResendInvite = async () => {
    setIsResending(true);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });
      const data = await res.json();

      if (res.ok) {
        if (data.emailNotConfigured && data.setupUrl) {
          navigator.clipboard.writeText(data.setupUrl);
          toast.success("📋 Invite link copied", {
            description: "Share it manually — email isn't configured",
          });
        } else {
          toast.success("📧 Invite re-sent", { description: user.email });
        }
        onRefresh();
      } else {
        toast.error("❌ Couldn't re-send invite", {
          description: data.error || undefined,
        });
      }
    } catch {
      toast.error("❌ Couldn't re-send invite", {
        description: "Network error — please try again",
      });
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-cyan-500 to-blue-500 flex items-center justify-center text-white text-xl font-medium">
                {(user.displayName || user.email)[0].toUpperCase()}
              </div>
              <div
                className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-slate-900 ${
                  user.isOnline ? "bg-green-500" : "bg-gray-500"
                }`}
              />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">
                {user.displayName || user.email.split("@")[0]}
              </h3>
              <p className="text-sm text-gray-400">{user.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {user.role !== "admin" && (
              <button
                onClick={() => onImpersonate(user)}
                className="p-2 text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition"
                title="View as user"
              >
                <Eye className="w-5 h-5" />
              </button>
            )}
            {user.status === "pending" && (
              <button
                onClick={handleResendInvite}
                disabled={isResending}
                className="p-2 text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition disabled:opacity-50"
                title="Re-send invite"
              >
                {isResending ? (
                  <RefreshCw className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            )}
            <button
              onClick={() => onForceLogout(user)}
              className="p-2 text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 rounded-lg transition"
              title="Force logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
            <button
              onClick={() => onToggleStatus(user)}
              className={`p-2 rounded-lg transition ${
                user.status === "suspended"
                  ? "text-green-400 hover:bg-green-500/10"
                  : "text-yellow-400 hover:bg-yellow-500/10"
              }`}
              title={user.status === "suspended" ? "Activate" : "Suspend"}
            >
              <Shield className="w-5 h-5" />
            </button>
            <button
              onClick={() => onDelete(user)}
              className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition"
              title="Delete user"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-1 px-4 py-2 border-b border-slate-800 bg-slate-800/30 shrink-0">
        <button
          onClick={() => setActiveTab("activity")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition flex items-center gap-2 ${
            activeTab === "activity"
              ? "bg-slate-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <Activity className="w-4 h-4" />
          Activity
        </button>
        <button
          onClick={() => setActiveTab("sessions")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition flex items-center gap-2 ${
            activeTab === "sessions"
              ? "bg-slate-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <Zap className="w-4 h-4" />
          Sessions
        </button>
        <button
          onClick={() => setActiveTab("permissions")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition flex items-center gap-2 ${
            activeTab === "permissions"
              ? "bg-slate-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <Shield className="w-4 h-4" />
          Permissions
        </button>
        <button
          onClick={() => setActiveTab("info")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition flex items-center gap-2 ${
            activeTab === "info"
              ? "bg-slate-700 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          <Info className="w-4 h-4" />
          Info
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "activity" && <ActivityTab userId={user.id} />}
        {activeTab === "sessions" && <SessionsTab userId={user.id} />}
        {activeTab === "permissions" && (
          <PermissionsTab user={user} onRefresh={onRefresh} />
        )}
        {activeTab === "info" && <InfoTab user={user} />}
      </div>
    </div>
  );
}

function ActivityTab({ userId }: { userId: string }) {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<ActionFilter>("all");
  const limit = 30;

  const fetchLogsAt = useCallback(
    async (nextOffset: number, reset = false) => {
      setIsLoading(true);
      try {
        const res = await fetch(
          `/api/auth/admin/users/${userId}/activity?limit=${limit}&offset=${nextOffset}`,
        );
        const data = await res.json();

        if (res.ok) {
          if (reset) {
            setLogs(data.logs);
          } else {
            setLogs((prev) => [...prev, ...data.logs]);
          }
          setHasMore(data.pagination.hasMore);
          setOffset(nextOffset + data.logs.length);
        }
      } catch {
      } finally {
        setIsLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    setLogs([]);
    setOffset(0);
    fetchLogsAt(0, true);
  }, [userId, fetchLogsAt]);

  const filteredLogs = logs.filter((log) => {
    if (filter === "all") return true;
    if (filter === "login")
      return log.action === "login" || log.action === "login_failed";
    if (filter === "logout")
      return log.action === "logout" || log.action === "force_logout";
    if (filter === "password") return log.action.includes("password");
    if (filter === "admin")
      return (
        log.action.includes("impersonation") ||
        log.action.includes("account") ||
        log.action === "permissions_updated" ||
        log.action === "force_logout" ||
        log.action.includes("invite")
      );
    return true;
  });

  if (isLoading && logs.length === 0) {
    return (
      <div className="text-center text-gray-400 py-8">Loading activity...</div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="text-center text-gray-400 py-8">
        <Activity className="w-10 h-10 mx-auto mb-2 opacity-50" />
        <p>No activity recorded yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-gray-500" />
        <div className="flex gap-1 flex-wrap">
          {ACTION_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
                filter === f.value
                  ? "bg-cyan-600 text-white"
                  : "bg-slate-700 text-gray-400 hover:text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {filteredLogs.length === 0 ? (
          <div className="text-center text-gray-500 py-6 text-sm">
            No {filter !== "all" ? filter : ""} activity found
          </div>
        ) : (
          filteredLogs.map((log) => {
            const ActionIcon = getActionIcon(log.action);
            return (
              <div
                key={log.id}
                className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 hover:border-slate-600/50 transition"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`p-2 rounded-lg bg-slate-700/50 ${getActionColor(log.action)}`}
                  >
                    <ActionIcon className="w-4 h-4" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-medium ${getActionColor(log.action)}`}
                        >
                          {getActionLabel(log.action)}
                        </span>
                        {log.performedBy && (
                          <span className="px-1.5 py-0.5 text-[10px] bg-cyan-500/20 text-cyan-300 rounded">
                            by admin
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-1 shrink-0">
                        <Clock className="w-3 h-3" />
                        <span title={formatDateTime(log.createdAt)}>
                          {formatRelativeTime(log.createdAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
                      {log.ipAddress && (
                        <span className="flex items-center gap-1.5 text-gray-300 font-mono bg-slate-700/50 px-2 py-0.5 rounded">
                          <Globe className="w-3 h-3 text-gray-500" />
                          {log.ipAddress}
                        </span>
                      )}
                      {log.geoLocation && (
                        <span className="flex items-center gap-1.5 text-gray-400">
                          <MapPin className="w-3 h-3" />
                          {log.geoLocation.city}, {log.geoLocation.country}
                        </span>
                      )}
                      {log.deviceInfo && (
                        <span className="flex items-center gap-1.5 text-gray-400">
                          <Laptop className="w-3 h-3" />
                          <span
                            className="truncate max-w-[200px]"
                            title={log.deviceInfo}
                          >
                            {log.deviceInfo}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {hasMore && filter === "all" && (
        <button
          onClick={() => fetchLogsAt(offset)}
          disabled={isLoading}
          className="w-full py-2 text-sm text-cyan-400 hover:text-cyan-300 transition"
        >
          {isLoading ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}

interface SessionData {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  geoLocation: { country: string; city: string } | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
  isCurrent: boolean;
  isImpersonation: boolean;
}

function SessionsTab({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(`/api/auth/admin/users/${userId}/sessions`);
      const data = await res.json();

      if (res.ok && data.data?.sessions) {
        setSessions(data.data.sessions);
        setActiveCount(data.data.activeCount || 0);
      } else {
        console.error("[SessionsTab] API error:", {
          status: res.status,
          error: data.error,
          userId,
          data,
        });
        setSessions([]);
        setActiveCount(0);
        setError(data.error || `Failed to load sessions (${res.status})`);
      }
    } catch (err) {
      console.error("[SessionsTab] Fetch error:", err);
      setSessions([]);
      setActiveCount(0);
      setError("Failed to load sessions. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const revokeSession = async (sessionId: string) => {
    setRevokingId(sessionId);
    try {
      const res = await fetch(`/api/auth/admin/users/${userId}/sessions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      if (res.ok) {
        toast.success("🔒 Session revoked");
        fetchSessions();
      } else {
        const data = await res.json();
        toast.error("❌ Couldn't revoke session", {
          description: data.error || undefined,
        });
      }
    } catch {
      toast.error("❌ Couldn't revoke session", {
        description: "Network error — please try again",
      });
    } finally {
      setRevokingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="text-center text-gray-400 py-8">Loading sessions...</div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 space-y-4">
        <div className="text-red-400">{error}</div>
        <button
          onClick={fetchSessions}
          className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition"
        >
          Retry
        </button>
      </div>
    );
  }

  const activeSessions = sessions.filter((s) => s.isActive);
  const expiredSessions = sessions.filter((s) => !s.isActive);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4 text-green-400" />
          Active Sessions ({activeCount})
        </h4>

        {activeSessions.length === 0 ? (
          <div className="text-center text-gray-500 py-4 bg-slate-800/30 rounded-lg text-sm">
            No active sessions
          </div>
        ) : (
          <div className="space-y-2">
            {activeSessions.map((session) => (
              <div
                key={session.id}
                className={`p-4 rounded-lg border ${
                  session.isCurrent
                    ? "bg-green-500/10 border-green-500/30"
                    : "bg-slate-800/50 border-slate-700/50"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      {session.isCurrent && (
                        <span className="px-2 py-0.5 text-[10px] bg-green-500/20 text-green-400 rounded font-medium">
                          CURRENT
                        </span>
                      )}
                      {session.isImpersonation && (
                        <span className="px-2 py-0.5 text-[10px] bg-cyan-500/20 text-cyan-400 rounded font-medium">
                          IMPERSONATION
                        </span>
                      )}
                    </div>

                    <div className="space-y-1.5 text-sm">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-gray-500" />
                        <span className="font-mono text-gray-300">
                          {session.ipAddress || "Unknown IP"}
                        </span>
                      </div>

                      {session.geoLocation && (
                        <div className="flex items-center gap-2 text-gray-400">
                          <MapPin className="w-4 h-4" />
                          <span>
                            {session.geoLocation.city},{" "}
                            {session.geoLocation.country}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-gray-400">
                        <Laptop className="w-4 h-4" />
                        <span className="truncate">
                          {session.deviceInfo || "Unknown device"}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Started: {formatDateTime(session.createdAt)}
                        </span>
                        <span>
                          Expires: {formatDateTime(session.expiresAt)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {!session.isCurrent && (
                    <button
                      onClick={() => revokeSession(session.id)}
                      disabled={revokingId === session.id}
                      className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition disabled:opacity-50"
                    >
                      {revokingId === session.id ? "Revoking..." : "Revoke"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {expiredSessions.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-500 mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Past Sessions ({expiredSessions.length})
          </h4>

          <div className="space-y-2">
            {expiredSessions.slice(0, 5).map((session) => (
              <div
                key={session.id}
                className="p-3 rounded-lg bg-slate-800/30 border border-slate-700/30 opacity-60"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <Globe className="w-4 h-4 text-gray-500" />
                      <span className="font-mono text-gray-400">
                        {session.ipAddress || "Unknown IP"}
                      </span>
                    </div>

                    {session.geoLocation && (
                      <div className="flex items-center gap-2 text-gray-500">
                        <MapPin className="w-4 h-4" />
                        <span>
                          {session.geoLocation.city},{" "}
                          {session.geoLocation.country}
                        </span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-gray-500">
                      <Laptop className="w-4 h-4" />
                      <span className="truncate">
                        {session.deviceInfo || "Unknown device"}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Started: {formatDateTime(session.createdAt)}
                      </span>
                      <span>
                        {session.revokedAt ? "Revoked" : "Expired"}:{" "}
                        {formatDateTime(session.revokedAt || session.expiresAt)}
                      </span>
                    </div>
                  </div>

                  <div className="text-xs text-gray-500 shrink-0">
                    {session.revokedAt ? (
                      <span className="text-red-400/70">Revoked</span>
                    ) : (
                      <span>Expired</span>
                    )}
                    {" · "}
                    {formatRelativeTime(session.revokedAt || session.expiresAt)}
                  </div>
                </div>
              </div>
            ))}

            {expiredSessions.length > 5 && (
              <div className="text-center text-xs text-gray-500 py-2">
                +{expiredSessions.length - 5} more past sessions
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_INFO: Record<string, { label: string; icon: typeof Eye }> = {
  view: { label: "View Features", icon: Eye },
  action: { label: "Actions", icon: Zap },
  data: { label: "Data Access", icon: Globe },
};

function PermissionsTab({
  user,
  onRefresh,
}: {
  user: UserData;
  onRefresh: () => void;
}) {
  const [permissions, setPermissions] = useState<PermissionData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    async function fetchPermissions() {
      try {
        const res = await fetch(`/api/auth/admin/users/${user.id}/permissions`);
        const data = await res.json();

        if (res.ok) {
          setPermissions(data.permissions || []);
        }
      } catch {
      } finally {
        setIsLoading(false);
      }
    }

    fetchPermissions();
  }, [user.id]);

  const togglePermission = async (featureId: string, enabled: boolean) => {
    setSavingId(featureId);

    try {
      const res = await fetch(`/api/auth/admin/users/${user.id}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          permissions: { [featureId]: enabled },
        }),
      });

      if (res.ok) {
        setPermissions((prev) =>
          prev.map((p) => (p.featureId === featureId ? { ...p, enabled } : p)),
        );
        const perm = permissions.find((p) => p.featureId === featureId);
        toast.success(
          enabled ? "✅ Permission enabled" : "🚫 Permission disabled",
          {
            description: perm?.displayName,
          },
        );
        onRefresh();
      } else {
        const data = await res.json();
        toast.error("❌ Couldn't update permission", {
          description: data.error || undefined,
        });
      }
    } catch {
      toast.error("❌ Couldn't update permission", {
        description: "Network error — please try again",
      });
    } finally {
      setSavingId(null);
    }
  };

  const toggleCategory = async (category: string, enabled: boolean) => {
    const categoryPerms = visiblePermissions.filter(
      (p) => p.category === category && p.implemented !== false,
    );
    if (categoryPerms.length === 0) return;

    const updates: Record<string, boolean> = {};
    categoryPerms.forEach((p) => {
      updates[p.featureId] = enabled;
    });

    try {
      const res = await fetch(`/api/auth/admin/users/${user.id}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: updates }),
      });

      if (res.ok) {
        setPermissions((prev) =>
          prev.map((p) =>
            updates[p.featureId] !== undefined
              ? { ...p, enabled: updates[p.featureId] }
              : p,
          ),
        );
        toast.success(
          enabled ? "✅ Category enabled" : "🚫 Category disabled",
          {
            description: CATEGORY_INFO[category]?.label || category,
          },
        );
        onRefresh();
      }
    } catch {
      toast.error("❌ Couldn't update permissions", {
        description: "Network error — please try again",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="text-center text-gray-400 py-8">
        Loading permissions...
      </div>
    );
  }

  const visiblePermissions = permissions.filter((p) => !p.adminOnly);

  const filteredPermissions = visiblePermissions.filter((p) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      p.displayName.toLowerCase().includes(term) ||
      p.description.toLowerCase().includes(term) ||
      p.featureId.toLowerCase().includes(term)
    );
  });

  const groupedPermissions = filteredPermissions.reduce(
    (acc, perm) => {
      const cat = perm.category || "other";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(perm);
      return acc;
    },
    {} as Record<string, PermissionData[]>,
  );

  const categoryOrder = ["view", "action", "data"];

  if (visiblePermissions.length === 0) {
    return (
      <div className="text-center text-gray-400 py-8">
        <Shield className="w-10 h-10 mx-auto mb-2 opacity-50" />
        <p>No configurable permissions</p>
      </div>
    );
  }

  const enabledCount = visiblePermissions.filter((p) => p.enabled).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search permissions..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
        </div>
        <div className="text-xs text-gray-500">
          {enabledCount}/{visiblePermissions.length} enabled
        </div>
      </div>

      {filteredPermissions.length === 0 ? (
        <div className="text-center text-gray-500 py-6 text-sm">
          No permissions match &quot;{searchTerm}&quot;
        </div>
      ) : (
        categoryOrder.map((category) => {
          const perms = groupedPermissions[category];
          if (!perms || perms.length === 0) return null;

          const catInfo = CATEGORY_INFO[category];
          const CatIcon = catInfo?.icon || Shield;
          const implementedPerms = perms.filter((p) => p.implemented !== false);
          const allEnabled =
            implementedPerms.length > 0 &&
            implementedPerms.every((p) => p.enabled);
          const someEnabled = implementedPerms.some((p) => p.enabled);
          const hasImplemented = implementedPerms.length > 0;

          return (
            <div key={category} className="space-y-1">
              <div className="flex items-center justify-between py-1.5 px-2 bg-slate-800/30 rounded-lg">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-400 uppercase tracking-wider">
                  <CatIcon className="w-3.5 h-3.5" />
                  {catInfo?.label || category} ({perms.length})
                </div>
                {hasImplemented && (
                  <button
                    onClick={() => toggleCategory(category, !allEnabled)}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 transition"
                  >
                    {allEnabled
                      ? "Disable all"
                      : someEnabled
                        ? "Enable all"
                        : "Enable all"}
                  </button>
                )}
              </div>

              <div className="space-y-0.5">
                {perms.map((perm) => {
                  const isImplemented = perm.implemented !== false;
                  return (
                    <div
                      key={perm.featureId}
                      className={`flex items-center justify-between py-2 px-3 rounded-lg transition group ${
                        isImplemented
                          ? "bg-slate-800/30 hover:bg-slate-800/50"
                          : "bg-slate-800/20 opacity-60"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-sm ${isImplemented ? "text-white" : "text-gray-400"}`}
                          >
                            {perm.displayName}
                          </span>
                          {!isImplemented && (
                            <span className="px-1.5 py-0.5 text-[9px] bg-yellow-500/20 text-yellow-400 rounded font-medium">
                              SOON
                            </span>
                          )}
                          <span className="text-[10px] text-gray-600 opacity-0 group-hover:opacity-100 transition">
                            {perm.featureId}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-500 truncate">
                          {perm.description}
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          isImplemented &&
                          togglePermission(perm.featureId, !perm.enabled)
                        }
                        disabled={!isImplemented || savingId === perm.featureId}
                        className={`relative w-10 h-5 rounded-full transition shrink-0 ml-3 ${
                          !isImplemented
                            ? "bg-slate-700 cursor-not-allowed"
                            : perm.enabled
                              ? "bg-cyan-600"
                              : "bg-slate-600"
                        } ${savingId === perm.featureId ? "opacity-50" : ""}`}
                        title={!isImplemented ? "Coming soon" : undefined}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            isImplemented && perm.enabled ? "translate-x-5" : ""
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function InfoTab({ user }: { user: UserData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
            Role
          </div>
          <div className="font-medium text-white capitalize">{user.role}</div>
        </div>
        <div className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
            Status
          </div>
          <div
            className={`font-medium capitalize ${
              user.status === "active"
                ? "text-green-400"
                : user.status === "suspended"
                  ? "text-red-400"
                  : "text-yellow-400"
            }`}
          >
            {user.status}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
            Created
          </div>
          <div className="font-medium text-white">
            {formatDate(user.createdAt)}
          </div>
        </div>
        <div className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
            Last Updated
          </div>
          <div className="font-medium text-white">
            {formatDate(user.updatedAt)}
          </div>
        </div>
      </div>

      <div className="p-4 rounded-lg bg-slate-800/50 border border-slate-700/50">
        <h4 className="text-sm font-medium text-gray-300 mb-3">
          Login Summary
        </h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Total logins</span>
            <span className="text-white font-medium">
              {user.activitySummary.totalLogins}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Last login</span>
            <span className="text-white">
              {user.activitySummary.lastLogin
                ? formatDateTime(user.activitySummary.lastLogin)
                : "Never"}
            </span>
          </div>
          {user.activitySummary.lastLoginLocation && (
            <div className="flex justify-between">
              <span className="text-gray-400">Last location</span>
              <span className="text-white">
                {user.activitySummary.lastLoginLocation.city},{" "}
                {user.activitySummary.lastLoginLocation.country}
              </span>
            </div>
          )}
          {user.activitySummary.lastLoginDevice && (
            <div className="flex justify-between">
              <span className="text-gray-400">Last device</span>
              <span
                className="text-white truncate max-w-[200px]"
                title={user.activitySummary.lastLoginDevice}
              >
                {user.activitySummary.lastLoginDevice}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
