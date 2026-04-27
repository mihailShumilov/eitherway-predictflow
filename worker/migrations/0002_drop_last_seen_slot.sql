-- Drop the unused `last_seen_slot` column from durable_nonces.
--
-- The column was selected by routes/durable-nonces.ts but never written —
-- a vestigial planned feature. Removing it cleans up the schema and the
-- TS types that mirror it. SQLite ≥ 3.35.0 (D1 ships a recent build)
-- supports ALTER TABLE DROP COLUMN natively.

ALTER TABLE durable_nonces DROP COLUMN last_seen_slot;
