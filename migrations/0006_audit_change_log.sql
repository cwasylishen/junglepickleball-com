-- Application audit log (brief decision 2; src/portal/audit.js is the
-- one writer) and the database-level change trail that catches writes
-- the application layer never saw (CTL-DATA-05). The trail holds no
-- values, only table/row/op/when (PII-03).

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES accounts(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before TEXT, -- JSON, nullable
  after TEXT, -- JSON, nullable
  at TEXT NOT NULL
);
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_account_id);

CREATE TABLE db_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('UPDATE', 'DELETE')),
  at TEXT NOT NULL
);

CREATE TRIGGER trg_bookings_update AFTER UPDATE ON bookings BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('bookings', OLD.id, 'UPDATE', datetime('now'));
END;
CREATE TRIGGER trg_bookings_delete AFTER DELETE ON bookings BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('bookings', OLD.id, 'DELETE', datetime('now'));
END;

CREATE TRIGGER trg_accounts_update AFTER UPDATE ON accounts BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('accounts', OLD.id, 'UPDATE', datetime('now'));
END;
CREATE TRIGGER trg_accounts_delete AFTER DELETE ON accounts BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('accounts', OLD.id, 'DELETE', datetime('now'));
END;

CREATE TRIGGER trg_grants_update AFTER UPDATE ON entitlement_grants BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('entitlement_grants', OLD.id, 'UPDATE', datetime('now'));
END;
CREATE TRIGGER trg_grants_delete AFTER DELETE ON entitlement_grants BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('entitlement_grants', OLD.id, 'DELETE', datetime('now'));
END;

CREATE TRIGGER trg_credits_update AFTER UPDATE ON credits BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('credits', OLD.account_id, 'UPDATE', datetime('now'));
END;
CREATE TRIGGER trg_credits_delete AFTER DELETE ON credits BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('credits', OLD.account_id, 'DELETE', datetime('now'));
END;

CREATE TRIGGER trg_households_update AFTER UPDATE ON households BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('households', OLD.id, 'UPDATE', datetime('now'));
END;
CREATE TRIGGER trg_households_delete AFTER DELETE ON households BEGIN
  INSERT INTO db_change_log (table_name, row_id, op, at) VALUES ('households', OLD.id, 'DELETE', datetime('now'));
END;
