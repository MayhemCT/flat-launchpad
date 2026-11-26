-- The last sync failure per chain, so a stalled index explains itself through the API.
ALTER TABLE sync_state ADD COLUMN last_error TEXT;
ALTER TABLE sync_state ADD COLUMN last_error_at INTEGER;
