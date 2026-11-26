-- Chat rooms: every token keeps its public room and gains a holder room, where only wallets that hold the
-- token can post. Anyone can read either. Messages stored before this are the public room's.
-- SQLite cannot add a CHECK to an existing table, so the Worker only ever writes 'public' or 'holders'.

ALTER TABLE chat_messages ADD COLUMN room TEXT NOT NULL DEFAULT 'public';
-- One room's messages, newest first, and everything after a given id for polling.
CREATE INDEX chat_messages_by_room ON chat_messages (chain, token, room, id);
