import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Load the repo-root .env.local so scripts and agents share one source of env.
// Existing process.env values win, so deployment env vars override the file.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../.env.local") });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Add it to .env.local at the repo root (or the deployment environment) before using @kazi-lab/db.",
  );
}

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });

export * from "./schema";
