import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not load .env files on its own, so load the repo-root
// .env.local explicitly before reading DATABASE_URL.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../.env.local") });

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
