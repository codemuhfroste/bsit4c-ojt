import { migrations } from "./migrations.js";

const url = process.env.TURSO_DATABASE_URL || "file:local.db";

// Hosted Turso is reached over HTTP with the web build (no native binary, which suits serverless hosts like
// Vercel). Local `file:` databases need the full client.
const { createClient } = await import(url.startsWith("file:") ? "@libsql/client" : "@libsql/client/web");

export const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Applies any migrations not yet recorded in schema_migrations, in order.
export async function migrate() {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const { rows } = await db.execute("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => Number(r.version)));

  for (const [i, statements] of migrations.entries()) {
    const version = i + 1;
    if (applied.has(version)) continue;
    await db.batch(
      [...statements, { sql: "INSERT INTO schema_migrations (version) VALUES (?)", args: [version] }],
      "write",
    );
  }
}

// Serverless instances start cold, so each one makes sure the schema is current before serving requests.
let ready;
export function ensureMigrated() {
  ready ??= migrate().catch((err) => {
    ready = undefined; // let the next request retry
    throw err;
  });
  return ready;
}

// True when err is a UNIQUE/PRIMARY KEY constraint violation (SQLite extended codes 2067 / 1555).
export function isUniqueViolation(err) {
  const code = Number(err?.rawCode ?? err?.cause?.rawCode);
  return code === 2067 || code === 1555 || /UNIQUE constraint failed/i.test(String(err?.message));
}
