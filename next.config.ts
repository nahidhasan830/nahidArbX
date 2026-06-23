import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
