-- How many times a wallet has sent its application to a room again after the first time. A wallet may do that
-- once: the dev reviews what was handed in, not a text that keeps changing under them.

ALTER TABLE room_applications ADD COLUMN resubmits INTEGER NOT NULL DEFAULT 0;
