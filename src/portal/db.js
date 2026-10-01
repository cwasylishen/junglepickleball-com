// D1 access helpers. This is the ONE place portal code builds SQL
// statements for cross-cutting concerns (batches, RETURNING inserts).
// Per-entity query vocabulary lives in the module that owns that entity
// (auth.js for sessions/tokens, entitlement.js for grants, booking.js for
// bookings, etc.) -- never inline in a route handler (database doctrine).

// D1 has no interactive transactions (R-6). `batch()` runs every
// statement as one transaction: all of it commits, or none of it does.
// Always prefer this over sequential awaits for anything that must be
// atomic (a booking + its calendar_outbox row, a grant + its audit row).
export async function runBatch(db, statements) {
  return db.batch(statements);
}

// R-6: use RETURNING, not meta.changes, to detect an insert actually
// happened (D1's meta.changes is not reliable across all drivers/modes).
export async function insertReturning(db, sql, bindings = []) {
  const stmt = db.prepare(`${sql} RETURNING *`).bind(...bindings);
  const row = await stmt.first();
  return row || null;
}

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// Explicit field-list helper (CTL-AUTHZ-03): callers pass the exact
// allowed columns and the exact values; nothing from a request body is
// ever spread directly onto a row. This does not decide WHICH fields are
// writable -- each handler names its own allow-list -- it only builds the
// SQL once so every handler shares one correct implementation.
export function buildUpdate(table, idColumn, idValue, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) throw new Error("buildUpdate: no fields given");
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${setClause} WHERE ${idColumn} = ?`;
  const bindings = [...cols.map((c) => fields[c]), idValue];
  return { sql, bindings };
}
