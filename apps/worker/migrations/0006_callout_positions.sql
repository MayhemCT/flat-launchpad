-- What a callout is weighed by: how much of the token its author held and what the market valued the token at
-- when it was posted, and whether the author still holds. Balances are token base units as decimal strings
-- (they do not fit an INTEGER); market caps are whole US dollars; times are unix seconds.
-- A callout posted before this migration has no reading (NULL) and cannot be approved.

ALTER TABLE callouts ADD COLUMN call_mcap    INTEGER;
ALTER TABLE callouts ADD COLUMN call_balance TEXT;
-- The latest reading of the author's balance, and when it was taken.
ALTER TABLE callouts ADD COLUMN held_balance TEXT;
-- 'open' or 'closed'. SQLite cannot add a CHECK to an existing table, so the Worker only ever writes these two.
-- A position closes when the held balance falls below a tenth of the balance at the call, and stays closed.
ALTER TABLE callouts ADD COLUMN position     TEXT NOT NULL DEFAULT 'open';
ALTER TABLE callouts ADD COLUMN closed_at    INTEGER;
-- The token's market cap when the position was found closed.
ALTER TABLE callouts ADD COLUMN closed_mcap  INTEGER;
ALTER TABLE callouts ADD COLUMN checked_at   INTEGER;

-- The cron re-reads open positions, the one checked longest ago first.
CREATE INDEX callouts_by_position ON callouts (position, checked_at);
