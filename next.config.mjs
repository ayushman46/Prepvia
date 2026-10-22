import { vadAssetVersion } from "./scripts/copy-vad-assets.mjs";

const vadAssetPath = `/vad/${vadAssetVersion()}/`;

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The interview room needs the microphone on this origin only.
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_VAD_ASSET_PATH: vadAssetPath,
  },
  // Native/optional deps that should be required at runtime, not bundled.
  serverExternalPackages: ["ws", "unpdf", "mongodb"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Versioned path, so the files can be cached forever.
        source: "/vad/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
  // Turbopack (default in Next 16) bundles onnxruntime-web/VAD without extra config.
  turbopack: {},
};

export default nextConfig;
