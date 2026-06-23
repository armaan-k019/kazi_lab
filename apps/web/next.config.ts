import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, so Next must transpile them.
  transpilePackages: ["@kazi-lab/db", "@kazi-lab/scribe", "@kazi-lab/critic"],
  // These have dynamic/native requires that should resolve at runtime rather
  // than be bundled: node-postgres, the PDF parser, and jsdom (used by the
  // any-URL ingestion path server-side).
  serverExternalPackages: ["pg", "pdf-parse", "jsdom"],
};

export default nextConfig;
