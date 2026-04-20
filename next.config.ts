import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // output: "standalone", // Incompatible with `next start`
  compress: true,
  experimental: {
    prerenderEarlyExit: false,
  },
};

export default nextConfig;
