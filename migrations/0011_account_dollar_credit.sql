-- Dollar account credit is distinct from court session credits.
ALTER TABLE accounts ADD COLUMN account_credit_cents INTEGER NOT NULL DEFAULT 0;
