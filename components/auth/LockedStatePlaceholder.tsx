"use client";

import { Lock, Mail } from "lucide-react";

export function LockedStatePlaceholder() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
          <Lock className="w-10 h-10 text-slate-500" />
        </div>

        <h2 className="text-2xl font-semibold text-white mb-3">
          Access Restricted
        </h2>

        <p className="text-gray-400 mb-6">
          Your account doesn&apos;t have access to any features at this time.
          Please contact your administrator to request access.
        </p>

        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800/50 border border-slate-700 text-sm text-gray-400">
          <Mail className="w-4 h-4" />
          <span>Contact your admin for assistance</span>
        </div>
      </div>
    </div>
  );
}
