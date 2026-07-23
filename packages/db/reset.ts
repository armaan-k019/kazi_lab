import { sql } from "drizzle-orm";
import { db } from "./index";

// Corpus reset: delete ALL data (libraries, papers, and every dependent row)
// while PRESERVING the schema and the drizzle migration ledger. This is
// irreversible. It is guarded at the CLI (RESET_CONFIRM=1) so it can never fire
// accidentally. The destructive step is a single atomic TRUNCATE ... CASCADE, so
// there is no partially-reset state.
//
// The table list is read from the catalog (every public table except the
// drizzle migration table), so it stays correct as the schema grows.
export async function resetCorpus(): Promise<{
  tables: string[];
  before: Record<string, number>;
  after: Record<string, number>;
}> {
  const tablesRes = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like '\\_\\_drizzle%'
    order by tablename`);
  const tables = tablesRes.rows.map((r) => r.tablename);

  const countAll = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of tables) {
      const r = await db.execute<{ c: number }>(sql.raw(`select count(*)::int c from "${t}"`));
      out[t] = r.rows[0].c;
    }
    return out;
  };

  const before = await countAll();
  // One atomic statement: truncate every data table, cascade through FKs, reset
  // identity sequences. The migration ledger table is excluded above, so schema
  // and applied-migration state are preserved.
  const list = tables.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  const after = await countAll();
  return { tables, before, after };
}
