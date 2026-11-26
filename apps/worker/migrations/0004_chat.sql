-- Token chat: one public room per token. Nobody logs in; every message carries the wallet signature that
-- proves who wrote it. Addresses and signatures are lowercase hex, times are unix seconds.

CREATE TABLE chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain       TEXT NOT NULL,
  token       TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- The server's clock when the message was stored, not the time the author signed.
  created_at  INTEGER NOT NULL,
  -- Stored in one canonical form, so a signature can be used once and never replayed.
  signature   TEXT NOT NULL UNIQUE
);
-- A room's messages, newest first, and everything after a given id for polling.
CREATE INDEX chat_messages_by_token  ON chat_messages (chain, token, id DESC);
-- The rate limit counts an author's recent messages across every room.
CREATE INDEX chat_messages_by_author ON chat_messages (author, created_at);
