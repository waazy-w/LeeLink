import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  discord_id TEXT UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  profile_id TEXT,
  game_name TEXT,
  rom_sha1 TEXT,
  status TEXT NOT NULL DEFAULT 'lobby',
  max_players INTEGER NOT NULL DEFAULT 4,
  settings_json TEXT NOT NULL,
  webhook_url TEXT,
  overlay_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_players (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  player_id TEXT NOT NULL,
  color TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, user_id),
  UNIQUE (run_id, player_id)
);

-- Append-only event log. Never updated or deleted; undo is another entry.
CREATE TABLE IF NOT EXISTS log (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  label TEXT,
  data BLOB NOT NULL,
  UNIQUE (run_id, player_id, version)
);

CREATE TABLE IF NOT EXISTS chat (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_run ON chat(run_id, at);

-- Community game profiles (ROM hack definitions created with the profile editor).
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
