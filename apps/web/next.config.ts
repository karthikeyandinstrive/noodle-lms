import path from "node:path";
import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self), payment=(self)" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

// npm workspaces hoist dependencies to the repo root.
const monorepoRoot = path.resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
  poweredByHeader: false,
  transpilePackages: ["@lms/rbac"],
  // Same-origin API proxy: cookies stay first-party (httpOnly, SameSite) and no CORS is needed.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
      { source: "/api-docs/:path*", destination: `${API_URL}/api-docs/:path*` },
      { source: "/api-docs", destination: `${API_URL}/api-docs` },
      { source: "/openapi.json", destination: `${API_URL}/openapi.json` },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
