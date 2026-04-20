"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/BrandLogo";

function SetupPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(true);
  const [isInvalid, setIsInvalid] = useState(false);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setIsInvalid(true);
      setIsValidating(false);
      return;
    }

    async function validateToken() {
      try {
        const res = await fetch(`/api/auth/setup-password?token=${token}`);
        const data = await res.json();

        if (!res.ok) {
          setIsInvalid(true);
          setError(data.error || "Invalid invite link");
        } else {
          setEmail(data.email);
        }
      } catch {
        setIsInvalid(true);
        setError("Failed to validate invite link");
      } finally {
        setIsValidating(false);
      }
    }

    validateToken();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/setup-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          confirmPassword,
          displayName: displayName.trim() || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to set up password");
        return;
      }

      // Redirect to dashboard
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (isValidating) {
    return (
      <div className="text-center">
        <div className="animate-spin h-8 w-8 border-2 border-cyan-500 border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-gray-400">Validating invite link...</p>
      </div>
    );
  }

  if (isInvalid) {
    return (
      <div className="text-center">
        <div className="mb-4 p-4 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200">
          <p className="font-medium">Invalid or expired invite</p>
          <p className="text-sm mt-1">
            This invite link is no longer valid. Please contact the
            administrator for a new invite.
          </p>
        </div>
        <Link
          href="/login"
          className="text-cyan-400 hover:text-cyan-300 transition"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-sm">
          {error}
        </div>
      )}

      <div className="mb-6 p-4 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
        <p className="text-sm text-cyan-200">
          Setting up account for: <strong>{email}</strong>
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label
            htmlFor="displayName"
            className="block text-sm font-medium text-gray-300 mb-1.5"
          >
            Display Name
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
            placeholder="e.g., Nahid"
          />
          <p className="text-xs text-gray-500 mt-1">
            How you want to be called in the app
          </p>
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-gray-300 mb-1.5"
          >
            Create Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
            placeholder="••••••••"
          />
          <p className="text-xs text-gray-500 mt-1">
            Min 8 chars, 1 uppercase, 1 lowercase, 1 number
          </p>
        </div>

        <div>
          <label
            htmlFor="confirmPassword"
            className="block text-sm font-medium text-gray-300 mb-1.5"
          >
            Confirm Password
          </label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Setting up..." : "Complete setup"}
        </button>
      </form>
    </>
  );
}

export default function SetupPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="w-full max-w-md px-4">
        <div className="bg-slate-900 rounded-xl shadow-xl p-8 border border-slate-800">
          {/* Logo/Title */}
          <div className="text-center mb-8">
            <BrandLogo size="lg" />
            <p className="text-gray-400 mt-2">Welcome! Set up your account</p>
          </div>

          <Suspense
            fallback={
              <div className="text-center text-gray-400">Loading...</div>
            }
          >
            <SetupPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
