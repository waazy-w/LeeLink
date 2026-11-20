import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from './index';
import type { ServerMessage } from '@leelink/shared/protocol';
import { buildRunState } from '@leelink/shared/engine/reducer';
import type { LogEntry } from '@leelink/shared/engine/types';

let base = '';
const app = createApp({ dbPath: ':memory:' });

beforeAll(async () => {
  await new Promise<void>((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.server.close(() => r())));

async function api<T = any>(path: string, opts: { method?: string; token?: string; body?: unknown; raw?: Uint8Array } = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body || opts.raw ? 'POST' : 'GET'),
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.raw ? (opts.raw as BodyInit) : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : ((await res.arrayBuffer()) as T) };
}

class Client {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => boolean)[] = [];
  constructor(runId: string, token: string) {
    this.ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', runId, token })));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { t: T }>> {
    const found = this.inbox.find((m) => m.t === t && pred(m as never));
    if (found) {
      this.inbox.splice(this.inbox.indexOf(found), 1);
      return Promise.resolve(found as never);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 3000);
      this.waiters.push((m) => {
        if (m.t === t && pred(m as never)) {
          this.inbox.splice(this.inbox.indexOf(m), 1);
          clearTimeout(timer);
          resolve(m as never);
          return true;
        }
        return false;
      });
    });
  }
  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }
  close() {
    this.ws.close();
  }
}

describe('server', () => {
  it('runs a two-player Soul Link end to end', async () => {
    const ash = (await api('/api/auth/guest', { body: { name: 'Ash' } })).data;
    const misty = (await api('/api/auth/guest', { body: { name: 'Misty' } })).data;
    expect((await api('/api/me', { token: ash.token })).data.user.name).toBe('Ash');

    const { run } = (await api('/api/runs', { token: ash.token, body: { name: 'Kanto Link', profileId: 'firered-bpre-rev0', preset: 'classic' } })).data;
    expect(run.inviteCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Invite preview hides the overlay key; join adds a player.
    const preview = (await api(`/api/invite/${run.inviteCode}`)).data;
    expect(preview.run.overlayKey).toBeUndefined();
    expect((await api(`/api/invite/${run.inviteCode}/join`, { method: 'POST', token: misty.token })).status).toBe(200);
    expect((await api(`/api/runs/${run.id}`, { token: misty.token })).data.players).toHaveLength(2);

    const a = new Client(run.id, ash.token);
    const m = new Client(run.id, misty.token);
    const wa = await a.next('welcome');
    await m.next('welcome');
    expect(wa.me).toBe('p1');
    // settings + two joins are already in the log, with FireRed level caps.
    expect(wa.log.map((e) => e.kind)).toEqual(['settings', 'player-join', 'player-join']);
    expect((wa.log[0] as Extract<LogEntry, { kind: 'settings' }>).levelCaps?.[0]).toMatchObject({ level: 14 });

    // Ash catches; Misty receives the entry with a server-assigned seq.
    const place = { id: 101, name: 'Route 1', area: 'Route 1' };
    const mon = (uid: string, species: number) => ({ uid, species, nickname: '', level: 3, hp: 12, maxHp: 12, status: 'ok', isEgg: false, otId: 1, heldItem: 0, moves: [], experience: 0 });
    a.send({ t: 'append', clientId: 'c1', entry: { kind: 'tracker', event: { type: 'obtained', place, mon: mon('a1', 16), method: 'caught' } } });
    const got = await m.next('entry');
    expect(got.entry).toMatchObject({ seq: 4, kind: 'tracker', playerId: 'p1' });
    m.send({ t: 'append', entry: { kind: 'tracker', event: { type: 'obtained', place, mon: mon('m1', 19), method: 'caught' } } });
    await a.next('entry', (x) => x.entry.seq === 5);

    // Clients can't forge other players or system entries.
    m.send({ t: 'append', entry: { kind: 'player-join', playerId: 'p9', name: 'x' } });
    expect((await m.next('error')).message).toMatch(/can't append/);

    // Death propagates; undoing someone else's event needs a dispute.
    a.send({ t: 'append', entry: { kind: 'tracker', event: { type: 'faint', place, mon: { uid: 'a1', species: 16, nickname: '', level: 3 }, cause: { kind: 'wild' } } } });
    const faint = await m.next('entry', (x) => x.entry.seq === 6);
    m.send({ t: 'append', entry: { kind: 'undo', target: faint.entry.seq } });
    expect((await m.next('error')).message).toMatch(/dispute/);
    m.send({ t: 'append', entry: { kind: 'dispute-open', disputeId: 'd1', target: 6, reason: 'lag death' } });
    await a.next('entry', (x) => x.entry.kind === 'dispute-open');

    const log = (await api(`/api/runs/${run.id}/log`, { token: ash.token })).data.log as LogEntry[];
    const state = buildRunState(log);
    // Grace period: no wild encounter event before, but 'obtained' sets the first encounter.
    expect(state.mons.a1.status).toBe('dead');
    expect(state.mons.m1.status).toBe('link-dead');
    expect(state.disputes.d1.status).toBe('open');
    a.send({ t: 'append', entry: { kind: 'dispute-vote', disputeId: 'd1', approve: true } });
    await m.next('entry', (x) => x.entry.kind === 'dispute-vote');
    const after = buildRunState((await api(`/api/runs/${run.id}/log`, { token: ash.token })).data.log);
    expect(after.mons.a1.status).toBe('alive');

    // Presence, chat and previews.
    a.send({ t: 'presence', presence: { romSha1: 'abc', location: 'Route 1', badges: 0 } });
    const pr = await m.next('presence', (x) => x.presence.playerId === 'p1' && x.presence.location === 'Route 1');
    expect(pr.presence.online).toBe(true);
    m.send({ t: 'chat', text: 'gg' });
    expect((await a.next('chat')).message).toMatchObject({ text: 'gg', playerId: 'p2' });
    m.send({ t: 'watch-frames', on: true });
    await new Promise((r) => setTimeout(r, 50));
    a.send({ t: 'frame', data: 'data:image/jpeg;base64,AAAA' });
    expect((await m.next('frame')).playerId).toBe('p1');

    // The first ROM hash becomes the run's reference.
    const r2 = (await api(`/api/runs/${run.id}`, { token: ash.token })).data.run;
    expect(r2.romSha1).toBe('abc');

    a.close();
    m.close();
  });

  it('versions cloud saves and skips unchanged uploads', async () => {
    const u = (await api('/api/auth/guest', { body: { name: 'Brock' } })).data;
    const { run } = (await api('/api/runs', { token: u.token, body: { name: 'Saves' } })).data;
    const put = (bytes: number[]) => api(`/api/runs/${run.id}/saves`, { method: 'PUT', token: u.token, raw: new Uint8Array(bytes) });
    expect((await put([1, 2, 3])).data.save.version).toBe(1);
    expect((await put([1, 2, 3])).data.unchanged).toBe(true);
    expect((await put([1, 2, 4])).data.save.version).toBe(2);
    const list = (await api(`/api/runs/${run.id}/saves`, { token: u.token })).data.saves;
    expect(list.map((s: { version: number }) => s.version)).toEqual([2, 1]);
    const dl = await api<ArrayBuffer>(`/api/runs/${run.id}/saves/${list[1].id}`, { token: u.token });
    expect([...new Uint8Array(dl.data)]).toEqual([1, 2, 3]);
    // Non-members can't read saves.
    const other = (await api('/api/auth/guest', { body: { name: 'Gary' } })).data;
    expect((await api(`/api/runs/${run.id}/saves`, { token: other.token })).status).toBe(403);
  });

  it('only lets the owner change settings, and records the change in the log', async () => {
    const owner = (await api('/api/auth/guest', { body: { name: 'Erika' } })).data;
    const guest = (await api('/api/auth/guest', { body: { name: 'Sabrina' } })).data;
    const { run } = (await api('/api/runs', { token: owner.token, body: { name: 'Rules', preset: 'casual' } })).data;
    await api(`/api/invite/${run.inviteCode}/join`, { method: 'POST', token: guest.token });
    expect((await api(`/api/runs/${run.id}`, { method: 'PATCH', token: guest.token, body: { name: 'hijack' } })).status).toBe(403);
    const settings = { ...run.settings, typeClause: true };
    expect((await api(`/api/runs/${run.id}`, { method: 'PATCH', token: owner.token, body: { settings } })).status).toBe(200);
    const log = (await api(`/api/runs/${run.id}/log`, { token: owner.token })).data.log as LogEntry[];
    expect(log.filter((e) => e.kind === 'settings')).toHaveLength(2);
    expect(buildRunState(log).settings.typeClause).toBe(true);
  });

  it('serves community hack profiles that extend built-ins', async () => {
    const u = (await api('/api/auth/guest', { body: { name: 'Bill' } })).data;
    const hack = { id: 'my-hack', name: 'My Hack', extends: 'firered-bpre-rev0', engine: 'gen3', generation: 3, platform: 'gba', match: { sha1: ['ff'] }, addresses: {}, offsets: {}, locations: { '88': 'New Pallet' } };
    expect((await api('/api/profiles/my-hack', { method: 'PUT', token: u.token, body: hack })).status).toBe(200);
    const bad = { ...hack, id: 'loop', extends: 'missing-base' };
    expect((await api('/api/profiles/loop', { method: 'PUT', token: u.token, body: bad })).status).toBe(500);
    expect((await api('/api/profiles/firered-bpre-rev0', { method: 'PUT', token: u.token, body: { ...hack, id: 'firered-bpre-rev0' } })).status).toBe(409);
    expect((await api('/api/profiles')).data.profiles.map((p: { id: string }) => p.id)).toEqual(['my-hack']);
  });
});
