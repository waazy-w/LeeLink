import type { DB } from './db';
import { id, inviteCode, sha256 } from './util';
import type { ChatMessage, RunPlayer, RunSummary, SaveVersion, UserInfo } from '@leelink/shared/protocol';
import { PLAYER_COLORS } from '@leelink/shared/protocol';
import type { LogEntry, LogEntryInput } from '@leelink/shared/engine/types';
import type { RuleSettings } from '@leelink/shared/engine/settings';
import type { GameProfile } from '@leelink/shared/profiles/types';

type Row = Record<string, unknown>;

const toUser = (r: Row): UserInfo => ({
  id: r.id as string,
  name: r.name as string,
  avatar: (r.avatar as string) ?? undefined,
  discord: !!r.discord_id,
});

const toRun = (r: Row): RunSummary => ({
  id: r.id as string,
  name: r.name as string,
  ownerId: r.owner_id as string,
  inviteCode: r.invite_code as string,
  profileId: (r.profile_id as string) ?? undefined,
  gameName: (r.game_name as string) ?? undefined,
  romSha1: (r.rom_sha1 as string) ?? undefined,
  status: r.status as RunSummary['status'],
  createdAt: r.created_at as number,
  maxPlayers: r.max_players as number,
  settings: JSON.parse(r.settings_json as string),
  hasWebhook: !!r.webhook_url,
  overlayKey: r.overlay_key as string,
});

export class Store {
  constructor(readonly db: DB) {}

  // ---- users
  createUser(name: string, extra: { discordId?: string; avatar?: string } = {}): { user: UserInfo; token: string } {
    const token = id(24);
    const uid = id();
    this.db
      .prepare('INSERT INTO users (id, name, avatar, discord_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid, name.slice(0, 32), extra.avatar ?? null, extra.discordId ?? null, sha256(token), Date.now());
    return { user: this.user(uid)!, token };
  }

  user(uid: string): UserInfo | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as Row | undefined;
    return r ? toUser(r) : undefined;
  }

  userByToken(token: string | undefined): UserInfo | undefined {
    if (!token) return undefined;
    const r = this.db.prepare('SELECT * FROM users WHERE token_hash = ?').get(sha256(token)) as Row | undefined;
    return r ? toUser(r) : undefined;
  }

  userByDiscord(discordId: string): UserInfo | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId) as Row | undefined;
    return r ? toUser(r) : undefined;
  }

  /** Issues a fresh token for an existing user (Discord login on a new device). */
  rotateToken(uid: string): string {
    const token = id(24);
    this.db.prepare('UPDATE users SET token_hash = ? WHERE id = ?').run(sha256(token), uid);
    return token;
  }

  updateUser(uid: string, fields: { name?: string; avatar?: string; discordId?: string }) {
    if (fields.name) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(fields.name.slice(0, 32), uid);
    if (fields.avatar) this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(fields.avatar, uid);
    if (fields.discordId) this.db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(fields.discordId, uid);
  }

  // ---- runs
  createRun(owner: UserInfo, p: { name: string; profileId?: string; gameName?: string; romSha1?: string; settings: RuleSettings; maxPlayers: number }): RunSummary {
    const rid = id();
    this.db
      .prepare(`INSERT INTO runs (id, name, owner_id, invite_code, profile_id, game_name, rom_sha1, status, max_players, settings_json, overlay_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'lobby', ?, ?, ?, ?)`)
      .run(rid, p.name.slice(0, 64), owner.id, inviteCode(), p.profileId ?? null, p.gameName ?? null, p.romSha1 ?? null,
        Math.min(4, Math.max(2, p.maxPlayers)), JSON.stringify(p.settings), id(12), Date.now());
    return this.run(rid)!;
  }

  run(rid: string): RunSummary | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(rid) as Row | undefined;
    return r ? toRun(r) : undefined;
  }

  runByInvite(code: string): RunSummary | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE invite_code = ?').get(code.toUpperCase()) as Row | undefined;
    return r ? toRun(r) : undefined;
  }

  runsForUser(uid: string): RunSummary[] {
    return (this.db
      .prepare('SELECT r.* FROM runs r JOIN run_players p ON p.run_id = r.id WHERE p.user_id = ? ORDER BY r.created_at DESC')
      .all(uid) as Row[]).map(toRun);
  }

  runsByStatus(status: RunSummary['status'], limit = 50): RunSummary[] {
    return (this.db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as Row[]).map(toRun);
  }

  updateRun(rid: string, f: { name?: string; settings?: RuleSettings; status?: RunSummary['status']; romSha1?: string; webhookUrl?: string | null; profileId?: string; gameName?: string }) {
    if (f.name !== undefined) this.db.prepare('UPDATE runs SET name = ? WHERE id = ?').run(f.name.slice(0, 64), rid);
    if (f.settings) this.db.prepare('UPDATE runs SET settings_json = ? WHERE id = ?').run(JSON.stringify(f.settings), rid);
    if (f.status) this.db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(f.status, rid);
    if (f.romSha1) this.db.prepare('UPDATE runs SET rom_sha1 = ? WHERE id = ?').run(f.romSha1, rid);
    if (f.webhookUrl !== undefined) this.db.prepare('UPDATE runs SET webhook_url = ? WHERE id = ?').run(f.webhookUrl, rid);
    if (f.profileId !== undefined) this.db.prepare('UPDATE runs SET profile_id = ? WHERE id = ?').run(f.profileId, rid);
    if (f.gameName !== undefined) this.db.prepare('UPDATE runs SET game_name = ? WHERE id = ?').run(f.gameName, rid);
  }

  webhookUrl(rid: string): string | undefined {
    const r = this.db.prepare('SELECT webhook_url FROM runs WHERE id = ?').get(rid) as Row | undefined;
    return (r?.webhook_url as string) ?? undefined;
  }

  players(rid: string): RunPlayer[] {
    return (this.db
      .prepare('SELECT p.*, u.name, u.avatar, u.discord_id, u.id AS uid FROM run_players p JOIN users u ON u.id = p.user_id WHERE p.run_id = ? ORDER BY p.joined_at')
      .all(rid) as Row[]).map((r) => ({
        playerId: r.player_id as string,
        user: toUser({ ...r, id: r.uid }),
        joinedAt: r.joined_at as number,
        color: r.color as string,
      }));
  }

  playerFor(rid: string, uid: string): RunPlayer | undefined {
    return this.players(rid).find((p) => p.user.id === uid);
  }

  addPlayer(rid: string, user: UserInfo): RunPlayer {
    const existing = this.playerFor(rid, user.id);
    if (existing) return existing;
    const players = this.players(rid);
    const pid = `p${players.length + 1}`;
    const color = PLAYER_COLORS[players.length % PLAYER_COLORS.length];
    this.db.prepare('INSERT INTO run_players (run_id, user_id, player_id, color, joined_at) VALUES (?, ?, ?, ?, ?)').run(rid, user.id, pid, color, Date.now());
    return this.playerFor(rid, user.id)!;
  }

  // ---- log
  log(rid: string): LogEntry[] {
    return (this.db.prepare('SELECT json FROM log WHERE run_id = ? ORDER BY seq').all(rid) as Row[]).map((r) => JSON.parse(r.json as string));
  }

  /** Appends with the next sequence number. SQLite serialises writers, so seqs never collide. */
  append(rid: string, input: LogEntryInput): LogEntry {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM log WHERE run_id = ?').get(rid) as Row;
    const entry = { ...input, seq: (row.s as number) + 1, at: Date.now() } as LogEntry;
    this.db.prepare('INSERT INTO log (run_id, seq, at, json) VALUES (?, ?, ?, ?)').run(rid, entry.seq, entry.at, JSON.stringify(entry));
    return entry;
  }

  // ---- saves (version history)
  addSave(rid: string, playerId: string, data: Uint8Array, sha1: string, label?: string): SaveVersion | undefined {
    const latest = this.db.prepare('SELECT * FROM saves WHERE run_id = ? AND player_id = ? ORDER BY version DESC LIMIT 1').get(rid, playerId) as Row | undefined;
    if (latest?.sha1 === sha1) return undefined; // unchanged
    const version = ((latest?.version as number) ?? 0) + 1;
    const sid = id();
    this.db.prepare('INSERT INTO saves (id, run_id, player_id, version, created_at, size, sha1, label, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, rid, playerId, version, Date.now(), data.length, sha1, label ?? null, data);
    // Keep the last 100 versions per player.
    this.db.prepare('DELETE FROM saves WHERE run_id = ? AND player_id = ? AND version <= ?').run(rid, playerId, version - 100);
    return this.saveMeta(sid);
  }

  saveMeta(sid: string): SaveVersion | undefined {
    const r = this.db.prepare('SELECT id, player_id, version, created_at, size, sha1, label FROM saves WHERE id = ?').get(sid) as Row | undefined;
    return r ? { id: r.id as string, playerId: r.player_id as string, version: r.version as number, createdAt: r.created_at as number, size: r.size as number, sha1: r.sha1 as string, label: (r.label as string) ?? undefined } : undefined;
  }

  saves(rid: string, playerId?: string): SaveVersion[] {
    const rows = (playerId
      ? this.db.prepare('SELECT id FROM saves WHERE run_id = ? AND player_id = ? ORDER BY version DESC').all(rid, playerId)
      : this.db.prepare('SELECT id FROM saves WHERE run_id = ? ORDER BY created_at DESC').all(rid)) as Row[];
    return rows.map((r) => this.saveMeta(r.id as string)!);
  }

  saveData(rid: string, sid: string): Uint8Array | undefined {
    const r = this.db.prepare('SELECT data FROM saves WHERE id = ? AND run_id = ?').get(sid, rid) as Row | undefined;
    return r ? (r.data as Uint8Array) : undefined;
  }

  // ---- chat
  addChat(rid: string, playerId: string, text: string, kind: ChatMessage['kind']): ChatMessage {
    const m: ChatMessage = { id: id(), playerId, at: Date.now(), text: text.slice(0, 500), kind };
    this.db.prepare('INSERT INTO chat (id, run_id, player_id, at, kind, text) VALUES (?, ?, ?, ?, ?, ?)').run(m.id, rid, playerId, m.at, kind, m.text);
    return m;
  }

  chat(rid: string, limit = 200): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM chat WHERE run_id = ? ORDER BY at DESC LIMIT ?').all(rid, limit) as Row[])
      .map((r) => ({ id: r.id as string, playerId: r.player_id as string, at: r.at as number, text: r.text as string, kind: r.kind as ChatMessage['kind'] }))
      .reverse();
  }

  // ---- community profiles
  profiles(): GameProfile[] {
    return (this.db.prepare('SELECT json FROM profiles ORDER BY updated_at DESC').all() as Row[]).map((r) => JSON.parse(r.json as string));
  }

  profileOwner(pid: string): string | undefined {
    const r = this.db.prepare('SELECT owner_id FROM profiles WHERE id = ?').get(pid) as Row | undefined;
    return (r?.owner_id as string) ?? undefined;
  }

  saveProfile(owner: string, p: GameProfile) {
    this.db.prepare('INSERT INTO profiles (id, owner_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(p.id, owner, JSON.stringify(p), Date.now());
  }

  deleteProfile(pid: string) {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(pid);
  }
}
