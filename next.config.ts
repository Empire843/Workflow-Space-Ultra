import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
