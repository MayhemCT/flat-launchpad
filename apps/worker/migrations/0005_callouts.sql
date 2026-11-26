-- Callouts: links to posts on X, pump.fun or fomo.family that call a token out. Nobody logs in; every callout
-- carries the wallet signature of whoever posted it. A reviewer wallet approves a callout by signing an EIP-712
-- attestation, which the author then takes to the rewards vault themselves. Addresses, hashes and signatures
-- are lowercase hex, times are unix seconds.

CREATE TABLE callouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain       TEXT NOT NULL,
  token       TEXT NOT NULL,
  author      TEXT NOT NULL,
  -- 0 = X, 1 = pump.fun, 2 = fomo.family.
  kind        INTEGER NOT NULL,
  -- The link in its one canonical spelling: https, no query, no fragment.
  url         TEXT NOT NULL,
  -- keccak256 of `url`. A link can be posted once, ever, by one wallet, under one token.
  link_hash   TEXT NOT NULL UNIQUE,
  -- "x:<handle>" for X; empty for the sites whose links name no profile.
  profile     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  -- Stored in one canonical form, so a signature can be used once and never replayed.
  signature   TEXT NOT NULL UNIQUE,
  -- The server's clock when the callout was stored, not the time the author signed.
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_at INTEGER,
  reviewer    TEXT,
  -- Set on approval: the round (unix day) the attestation is for, when it stops being valid, and the
  -- reviewer's EIP-712 signature itself.
  epoch       INTEGER,
  deadline    INTEGER,
  attestation TEXT
);
-- A token's feed, newest first.
CREATE INDEX callouts_by_token  ON callouts (chain, token, id);
-- The review queue.
CREATE INDEX callouts_by_status ON callouts (chain, status, id);
-- The posting limits count an author's recent callouts.
CREATE INDEX callouts_by_author ON callouts (author, created_at);
