import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal "apply *.sql migrations in order, skip ones already recorded" runner.
 * No framework glue — works identically from source (tsx) and from the bundled
 * prod build because it resolves the migrations directory relative to CWD.
 */
export async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM _migrations"))
        .rows.map((r) => r.name),
    );

    // In prod the server is bundled to /app/dist/server/index.js; drizzle/
    // lives at /app/drizzle. In dev (tsx), __dirname is app/server/db, so
    // ../../drizzle resolves to app/drizzle. Try both paths.
    const candidates = [
      resolve(__dirname, "../../drizzle"),
      resolve(process.cwd(), "drizzle"),
    ];
    const migrationsDir =
      candidates.find((p) => safeDirExists(p)) ?? candidates[0];

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(migrationsDir, file), "utf8");
      console.log(`→ applying migration ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

function safeDirExists(p: string) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}
