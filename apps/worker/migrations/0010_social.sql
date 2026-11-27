-- The social side of CallZ: sign-in sessions, rooms with their applications, private chat and pictures, the
-- points and tags a room's dev gives its members, and clans. Addresses and hashes are lowercase hex, times are
-- unix seconds, and amounts that do not fit a 64-bit integer are decimal text.

-- A wallet signs in once with a signature and gets a token; what is kept is the token's SHA-256, never the
-- token. Private rooms are read with it, so nobody signs every request.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- The sign-in signature, in one canonical form, so it can be used once and never replayed.
  signature  TEXT NOT NULL UNIQUE
);
CREATE INDEX sessions_by_wallet ON sessions (wallet, expires_at);

-- A room is a CallZRoom contract on BNB Chain. Who created it, what it costs, who holds a pass and whether it
-- launched are copied from the chain and never typed by anyone; `synced_at` says when they were last read.
-- What the dev writes here is the description and which requirements an applicant has to meet.
CREATE TABLE rooms (
  address       TEXT PRIMARY KEY,
  creator       TEXT NOT NULL,
  name          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  -- The picture's address, as the contract holds it.
  image         TEXT NOT NULL DEFAULT '',
  about         TEXT NOT NULL DEFAULT '',
  -- Requirement: make a post on X. `post_brief` is what the dev asks it to say.
  want_post     INTEGER NOT NULL DEFAULT 0 CHECK (want_post IN (0, 1)),
  post_brief    TEXT NOT NULL DEFAULT '',
  -- Requirement: state a role and show a portfolio. `role_brief` is what the dev is looking for.
  want_role     INTEGER NOT NULL DEFAULT 0 CHECK (want_role IN (0, 1)),
  role_brief    TEXT NOT NULL DEFAULT '',
  -- Requirement: hold a token. Fixed in the contract at creation; NULL when the room has none.
  gate_token    TEXT,
  gate_amount   TEXT,
  gate_symbol   TEXT,
  gate_decimals INTEGER,
  seat_price    TEXT NOT NULL,
  seats         INTEGER NOT NULL,
  seated        INTEGER NOT NULL DEFAULT 0,
  sale_deadline INTEGER NOT NULL,
  pool_share_bps INTEGER NOT NULL,
  launch_fee_bps INTEGER NOT NULL,
  launched      INTEGER NOT NULL DEFAULT 0 CHECK (launched IN (0, 1)),
  token         TEXT,
  pair          TEXT,
  created_at    INTEGER NOT NULL,
  synced_at     INTEGER NOT NULL
);
CREATE INDEX rooms_by_created ON rooms (created_at DESC);
CREATE INDEX rooms_by_sync    ON rooms (launched, synced_at);

-- The wallets holding a pass, as last read from the room's contract. `sync` is the reading a row was last
-- seen in: rows from an older reading are wallets that no longer hold one.
CREATE TABLE room_members (
  room      TEXT NOT NULL,
  wallet    TEXT NOT NULL,
  seat      INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  sync      INTEGER NOT NULL,
  PRIMARY KEY (room, wallet)
);
CREATE INDEX room_members_by_wallet ON room_members (wallet);

-- One application per wallet per room, with what each requirement read the last time it was checked.
CREATE TABLE room_applications (
  room            TEXT NOT NULL,
  wallet          TEXT NOT NULL,
  -- The applicant's post on X, in its one canonical spelling, and the account that made it.
  post_url        TEXT,
  post_handle     TEXT,
  -- 'ok': the post is up and carries the applicant's code. 'missing': X says there is no such post.
  -- 'nocode': it is up without the code. 'unreachable': X could not be asked.
  post_state      TEXT CHECK (post_state IN ('ok', 'missing', 'nocode', 'unreachable')),
  role            TEXT,
  portfolio       TEXT,
  -- What the wallet held of the room's token, and whether that was enough.
  held            TEXT,
  hold_state      TEXT CHECK (hold_state IN ('ok', 'short', 'unreadable')),
  checked_at      INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'declined')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (room, wallet)
);
CREATE INDEX room_applications_by_wallet ON room_applications (wallet);
-- A post answers one application: nobody else can hand in the same one.
CREATE UNIQUE INDEX room_applications_by_post ON room_applications (room, post_url) WHERE post_url IS NOT NULL;

-- Pictures. `room` is '' for a room's own picture, which anyone may see, and the room's address for a picture
-- posted in its chat, which only its members may. The key is the SHA-256 of the bytes, so an address can only
-- ever show the picture it was made for.
CREATE TABLE pictures (
  hash       TEXT NOT NULL,
  room       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size       INTEGER NOT NULL,
  bytes      BLOB NOT NULL,
  uploader   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (hash, room)
);
CREATE INDEX pictures_by_uploader ON pictures (uploader, created_at);

-- A room's private chat. Only the dev and the wallets holding a pass read or write it.
CREATE TABLE room_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  -- The picture posted with the message, if any: a row of `pictures` for this room.
  picture    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX room_messages_by_room   ON room_messages (room, id);
CREATE INDEX room_messages_by_author ON room_messages (author, created_at);

-- Wallets the dev has taken out of the chat. Before the launch a member is removed on chain, with their money
-- back; after it, a pass can no longer be taken away, and this is what is left.
CREATE TABLE room_mutes (
  room       TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room, wallet)
);

-- Points a room's dev gave a member, one row per award. A member gets at most 100 from one room in all.
CREATE TABLE room_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  points     INTEGER NOT NULL CHECK (points BETWEEN 1 AND 100),
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX room_points_by_room   ON room_points (room, wallet);
CREATE INDEX room_points_by_wallet ON room_points (wallet);

-- The project tag a room's dev gave a member: it says this wallet works on this project, and as what.
CREATE TABLE room_tags (
  room       TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room, wallet)
);
CREATE INDEX room_tags_by_wallet ON room_tags (wallet);

-- Clans. A wallet is in one clan at most; its tag is shown in brackets before the wallet's name everywhere.
CREATE TABLE clans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 2 to 5 capital letters and digits.
  tag        TEXT NOT NULL UNIQUE CHECK (length(tag) BETWEEN 2 AND 5 AND tag NOT GLOB '*[^A-Z0-9]*'),
  name       TEXT NOT NULL,
  -- The name in lowercase: two names that differ only in case are the same name.
  name_key   TEXT NOT NULL UNIQUE,
  founder    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE clan_members (
  wallet     TEXT PRIMARY KEY,
  clan_id    INTEGER NOT NULL,
  invited_by TEXT,
  joined_at  INTEGER NOT NULL
);
CREATE INDEX clan_members_by_clan ON clan_members (clan_id, joined_at);
CREATE TABLE clan_invites (
  clan_id    INTEGER NOT NULL,
  wallet     TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (clan_id, wallet)
);
CREATE INDEX clan_invites_by_wallet ON clan_invites (wallet);
