import type { NextConfig } from "next";

import { createTabloomFrontDoorRewrites } from "./front-door-routes";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/s/:path*",
      headers: [
        { key: "Cache-Control", value: "private, no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }];
  },
  async rewrites() {
    const hasUpstream = Boolean(process.env.TABLOOM_MCP_UPSTREAM_ORIGIN?.trim());
    if (!hasUpstream) {
      if (process.env.VERCEL === "1") {
        throw new Error("TABLOOM_MCP_UPSTREAM_ORIGIN is required on Vercel");
      }

      return { beforeFiles: [], afterFiles: [], fallback: [] };
    }

    return {
      beforeFiles: createTabloomFrontDoorRewrites({
        TABLOOM_MCP_UPSTREAM_ORIGIN: process.env.TABLOOM_MCP_UPSTREAM_ORIGIN,
      }),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
