-- Add an immutable broadcast timestamp to orders.
--
-- The confirmation-timeout clock in checkSubmittedOrder previously measured
-- age from updated_at, which is rewritten on every state transition (including
-- transient rollbacks and re-broadcast persistence). That could reset the
-- give-up clock and prematurely mark a still-confirming tx as
-- confirmation_timeout. broadcast_at is written exactly once — when the
-- fill_signature is first persisted — and is the stable baseline for the age
-- check. Nullable so pre-existing in-flight rows fall back to updated_at.
ALTER TABLE orders ADD COLUMN broadcast_at INTEGER;
