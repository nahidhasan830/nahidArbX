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
    "onnxruntime-node",
    "@google-cloud/storage",
    "@google-cloud/run",
  ],
};

export default nextConfig;
