-- Display names: a wallet can give itself a name, shown beside its address wherever it appears as an author.
-- Nobody logs in; a name is set, changed or removed by a request the wallet signed. One row per wallet.
-- A wallet that removed its name keeps its row, without a name: the row is what remembers when the wallet last
-- changed it, so an older signed request can never bring a name back. Addresses and signatures are lowercase
-- hex, times are unix seconds.

CREATE TABLE wallet_names (
  wallet     TEXT PRIMARY KEY,
  -- The name as it was typed. NULL once removed.
  name       TEXT,
  -- The name in lowercase: two names that differ only in case are the same name. NULL once removed.
  name_key   TEXT,
  -- The server's clock when the name was last set or removed, not the time the wallet signed.
  updated_at INTEGER NOT NULL,
  -- The request that made the last change, in one canonical form, so a signed request can be used once and
  -- never replayed.
  signature  TEXT NOT NULL UNIQUE,
  -- The Worker checks every name before it gets here. These say the same once more, where nothing can skip
  -- them: 3 to 20 ASCII letters, digits and underscores, starting with a letter, with the key its lowercase.
  CHECK ((name IS NULL) = (name_key IS NULL)),
  CHECK (name IS NULL OR (length(name) BETWEEN 3 AND 20 AND name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_]*')),
  CHECK (name_key IS NULL OR name_key = lower(name))
);
-- One wallet per name, whatever its capitals. Wallets without a name (NULL) do not collide.
CREATE UNIQUE INDEX wallet_names_by_key ON wallet_names (name_key);
