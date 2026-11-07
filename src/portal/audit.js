// The one audit-writing function (database doctrine: one named function
// per recurring activity). Every actor/action that must be traceable
// calls this; nothing else inserts into audit_log.

import { newId, nowIso } from "./db.js";

// actor: account id or null (e.g. a webhook with no human actor).
// before/after: plain objects or null; stored as JSON.
export async function writeAudit(db, { actor, action, targetType, targetId, before = null, after = null }) {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_account_id, action, target_type, target_id, before, after, at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(
      newId(),
      actor || null,
      action,
      targetType,
      targetId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      nowIso()
    )
    .run();
}

// Same shape, but returns the prepared statement instead of running it,
// so a caller can include the audit write in the SAME batch as the
// change it is auditing (e.g. a hand grant + its audit row, one
// transaction).
export function auditStatement(db, { actor, action, targetType, targetId, before = null, after = null }) {
  return db
    .prepare(
      `INSERT INTO audit_log (id, actor_account_id, action, target_type, target_id, before, after, at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(
      newId(),
      actor || null,
      action,
      targetType,
      targetId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      nowIso()
    );
}
