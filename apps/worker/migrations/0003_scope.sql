-- Memescope: how far each raise has come, token pictures, and what each quote token is called.

-- Quote-token balance the Launcher holds, in base units (decimal TEXT). Read from the chain while it raises.
ALTER TABLE launchers ADD COLUMN raised TEXT;
ALTER TABLE launchers ADD COLUMN raised_at INTEGER;

-- IPFS path of the token's picture, resolved from its `meta`. NULL until resolved, or when it has none.
ALTER TABLE tokens ADD COLUMN image TEXT;
ALTER TABLE tokens ADD COLUMN image_checked_at INTEGER;
ALTER TABLE tokens ADD COLUMN image_tries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tokens_image_pending ON tokens (chain, image_checked_at) WHERE image IS NULL AND meta IS NOT NULL;

CREATE TABLE quote_tokens (
  chain       TEXT NOT NULL,
  address     TEXT NOT NULL,
  symbol      TEXT,
  decimals    INTEGER,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);
