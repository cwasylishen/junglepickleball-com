// A real-SQLite stand-in for the D1 binding, for in-process tests that
// need a database but no `wrangler dev` (and so no network, no port).
// D1 is SQLite; this applies the project's own migrations in order and
// exposes the small slice of the D1 API the portal uses:
// prepare().bind().first()/all()/run(), and batch() as ONE transaction
// (all of it or none of it, as on D1).
//
// Not a mock of behaviour: every SQL statement runs on a real SQLite
// engine with foreign keys on, exactly as D1 does.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);

class Statement {
  constructor(sqlite, sql, args = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.sqlite, this.sql, args);
  }
  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.args) || null;
    return row && column ? row[column] : row;
  }
  async all() {
    const results = this.sqlite.prepare(this.sql).all(...this.args);
    return { results, success: true, meta: {} };
  }
  async run() {
    return this.all();
  }
}

export function openTestDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(new URL("migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrations) sqlite.exec(readFileSync(new URL(`migrations/${file}`, ROOT), "utf8"));
  return {
    sqlite,
    prepare: (sql) => new Statement(sqlite, sql),
    // One transaction: if any statement throws, none of them is kept.
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    // Runs a whole .sql file (a seed), the way `wrangler d1 execute --file` does.
    execFile(relativePath) {
      sqlite.exec(readFileSync(new URL(relativePath, ROOT), "utf8"));
    },
  };
}
