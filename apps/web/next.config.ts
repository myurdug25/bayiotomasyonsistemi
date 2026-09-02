import type { NextConfig } from "next";

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), bluetooth=(self)",
  },
  {
    key: "Content-Security-Policy",
    value: "upgrade-insecure-requests; frame-ancestors 'self'",
  },
];

const publicAssetCacheHeaders = [
  {
    key: "Cache-Control",
    value: "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800",
  },
];

const noStoreHeaders = [
  {
    key: "Cache-Control",
    value: "no-store, no-cache, must-revalidate, proxy-revalidate",
  },
  {
    key: "Pragma",
    value: "no-cache",
  },
  {
    key: "Expires",
    value: "0",
  },
];

const staticAssetHeaders = [...securityHeaders, ...publicAssetCacheHeaders];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  experimental: {
    cpus: 1,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: "/brand/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/dashboard-icons/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/app-icons/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/assets/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/apple-icons/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/login",
        headers: [...securityHeaders, ...noStoreHeaders],
      },
      {
        source: "/menu-emojis/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/pwa/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/sidebar/:path*",
        headers: staticAssetHeaders,
      },
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
