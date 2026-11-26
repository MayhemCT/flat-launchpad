-- Pool Launch index. Addresses and hashes are lowercase hex. uint256 values are
-- decimal TEXT because they do not fit SQLite integers.

CREATE TABLE sync_state (
  chain            TEXT PRIMARY KEY,
  next_block       INTEGER NOT NULL,
  head             INTEGER NOT NULL,
  creation_paused  INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE launcher_factories (
  chain              TEXT NOT NULL,
  address            TEXT NOT NULL,
  enabled            INTEGER,
  multiplier_bps     INTEGER,
  first_seen_block   INTEGER NOT NULL,
  status_checked_at  INTEGER,
  PRIMARY KEY (chain, address)
);

CREATE TABLE vault_factories (
  chain             TEXT NOT NULL,
  address           TEXT NOT NULL,
  enabled           INTEGER,
  official          INTEGER,
  risk_level        INTEGER,
  multiplier_bps    INTEGER,
  first_seen_block  INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);

CREATE TABLE launchers (
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  factory       TEXT NOT NULL,
  creator       TEXT NOT NULL,
  description   TEXT NOT NULL,
  block_number  INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  timestamp     INTEGER,
  PRIMARY KEY (chain, address)
);
CREATE INDEX launchers_by_creator ON launchers (chain, creator);
CREATE INDEX launchers_by_factory ON launchers (chain, factory);
CREATE INDEX launchers_by_block   ON launchers (chain, block_number DESC);

CREATE TABLE tokens (
  chain              TEXT NOT NULL,
  address            TEXT NOT NULL,
  kind               INTEGER NOT NULL,
  creator            TEXT NOT NULL,
  schema_id          TEXT NOT NULL,
  -- NULL for all of these when schema_id is a layout this indexer does not know.
  name               TEXT,
  symbol             TEXT,
  meta               TEXT,
  pool               TEXT,
  quote_token        TEXT,
  total_supply       TEXT,
  initial_price_wad  TEXT,
  nonce              TEXT,
  block_number       INTEGER NOT NULL,
  tx_hash            TEXT NOT NULL,
  timestamp          INTEGER,
  vault              TEXT,
  vault_factory      TEXT,
  graduated          INTEGER NOT NULL DEFAULT 0,
  dist_target        INTEGER,
  dist_strategy      TEXT,
  dist_amount        TEXT,
  -- The Launcher that launched the token: the launch transaction's `to`.
  launcher           TEXT,
  launcher_checked   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, address)
);
CREATE INDEX tokens_by_creator       ON tokens (chain, creator);
CREATE INDEX tokens_by_launcher      ON tokens (chain, launcher);
CREATE INDEX tokens_by_vault_factory ON tokens (chain, vault_factory);
CREATE INDEX tokens_by_block         ON tokens (chain, block_number DESC);
CREATE INDEX tokens_unlinked         ON tokens (chain, launcher_checked) WHERE launcher_checked = 0;
