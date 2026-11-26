-- The transaction that took an approved callout to the rewards vault, when the Worker sent it: its hash, or
-- 'recorded' when the vault had already counted the link by the time the Worker looked. NULL until then, and
-- again whenever the callout is approved anew.

ALTER TABLE callouts ADD COLUMN record_tx TEXT;
