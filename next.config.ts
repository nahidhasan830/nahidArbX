import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // These packages use native addons or Node-only APIs that webpack cannot
  // resolve during client-side compilation tracing. They are only imported
  // dynamically inside instrumentation.ts (server-only boot code).
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "pg-native",
    "better-sqlite3",
    "bufferutil",
    "utf-8-validate",
    "@google-cloud/storage",
    "@google-cloud/run",
  ],
  // Workaround for Next.js 16 prerender bug: turbopack minification of the
  // auto-generated /_global-error route corrupts the React import, so
  // useContext returns null at prerender time. Keep the debug-prerender flags
  // that are valid in a normal production build.
  // Tracked in vercel/next.js #93011, #93024, #86965, #86178, #85668, #84994.
  experimental: {
    prerenderEarlyExit: false,
    serverSourceMaps: true,
    turbopackMinify: false,
  },
};

export default nextConfig;
