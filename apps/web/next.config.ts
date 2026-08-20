import type { NextConfig } from "next";

const apiOrigin = (process.env.LUMOS_API_ORIGIN ?? "http://127.0.0.1:8787").replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
