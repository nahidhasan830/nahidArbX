"use client";

import { useState } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Copy, AlertTriangle } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResetUrl(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to send reset email");
        return;
      }

      // Check if email wasn't actually sent
      if (data.data?.emailNotConfigured && data.data?.resetUrl) {
        setResetUrl(data.data.resetUrl);
      }

      setSuccess(true);
    } catch {
      setError("An error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = () => {
    if (resetUrl) {
      navigator.clipboard.writeText(resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="w-full max-w-md px-4">
        <div className="bg-slate-900 rounded-xl shadow-xl p-8 border border-slate-800">
          {/* Logo/Title */}
          <div className="text-center mb-8">
            <BrandLogo size="lg" />
            <p className="text-gray-400 mt-2">Reset your password</p>
          </div>

          {success ? (
            <div className="text-center">
              {resetUrl ? (
                /* Email not configured - show manual link */
                <div className="space-y-4 text-left">
                  <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-yellow-200 font-medium">
                          Email not configured
                        </p>
                        <p className="text-yellow-200/70 text-sm mt-1">
                          Use this link to reset your password:
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-800 border border-slate-700">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={resetUrl}
                        readOnly
                        className="flex-1 bg-transparent text-sm text-gray-300 font-mono outline-none truncate"
                      />
                      <button
                        onClick={handleCopy}
                        className="p-2 hover:bg-slate-700 rounded-lg transition text-gray-400 hover:text-white shrink-0"
                      >
                        {copied ? (
                          <span className="text-green-400 text-xs">
                            Copied!
                          </span>
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <Link
                    href={resetUrl}
                    className="block w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium transition text-center"
                  >
                    Reset Password
                  </Link>
                </div>
              ) : (
                /* Normal success message */
                <div className="mb-4 p-4 rounded-lg bg-green-500/20 border border-green-500/50 text-green-200">
                  <p className="font-medium">Check your email</p>
                  <p className="text-sm mt-1">
                    If an account exists with this email, we&apos;ve sent a
                    password reset link.
                  </p>
                </div>
              )}
              <Link
                href="/login"
                className="text-cyan-400 hover:text-cyan-300 transition mt-4 inline-block"
              >
                Back to login
              </Link>
            </div>
          ) : (
            <>
              {/* Error Message */}
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-sm">
                  {error}
                </div>
              )}

              <p className="text-gray-400 text-sm mb-6">
                Enter your email address and we&apos;ll send you a link to reset
                your password.
              </p>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-300 mb-1.5"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition"
                    placeholder="you@example.com"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Sending..." : "Send reset link"}
                </button>
              </form>

              {/* Back to Login */}
              <div className="mt-6 text-center">
                <Link
                  href="/login"
                  className="text-sm text-cyan-400 hover:text-cyan-300 transition"
                >
                  Back to login
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
