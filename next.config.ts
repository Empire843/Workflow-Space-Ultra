import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname),
  serverExternalPackages: ["playwright", "playwright-core"],
  experimental: {
    // Playwright cần native module, phải mark external
  },
  webpack: (config) => {
    // Tránh bundle playwright vào client
    config.externals = [...(config.externals || []), "playwright", "playwright-core"];
    return config;
  },
};

export default nextConfig;
