import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { PRESETS, type PresetName, type RuleSettings } from '@leelink/shared/engine/settings';
import { ProfileRegistry } from '@leelink/shared/profiles/registry';
import type { GameProfile } from '@leelink/shared/profiles/types';
import { runStats } from '@leelink/shared/engine/stats';
import type { UserInfo } from '@leelink/shared/protocol';
import type { Store } from './store';
import type { Rooms } from './rooms';
import { bearer, HttpError, json, readBody, readJson, sha1 } from './util';
import { discordAuthorizeUrl, discordConfig, discordExchange } from './discord';

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  user?: UserInfo;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

export function createHttpHandler(store: Store, rooms: Rooms, staticDir?: string) {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler });
  };

  const registry = () => {
    const r = new ProfileRegistry();
    for (const p of store.profiles()) r.add(p);
    return r;
  };

  const needUser = (ctx: Ctx) => {
    if (!ctx.user) throw new HttpError(401, 'sign in first');
    return ctx.user;
  };
  const needMember = (ctx: Ctx, runId: string) => {
    const user = needUser(ctx);
    const run = store.run(runId);
    if (!run) throw new HttpError(404, 'run not found');
    const player = store.playerFor(runId, user.id);
    if (!player) throw new HttpError(403, 'not a member of this run');
    return { user, run, player };
  };

  /** Appends a settings entry carrying the game's level caps and typing info. */
  const appendSettings = (runId: string, settings: RuleSettings, profileId?: string) => {
    const profile = profileId ? registry().resolve(profileId) : undefined;
    rooms.appendSystem(runId, {
      kind: 'settings',
      settings,
      levelCaps: profile?.levelCaps ?? [],
      game: profile ? { profileId: profile.id, generation: profile.typingGeneration ?? profile.generation, typeOverrides: profile.typeOverrides } : { generation: 3 },
    });
  };

  const tokenCookie = (token: string) => `ll_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;

  // ---- auth
  route('GET', '/api/me', (ctx) => ({ user: ctx.user ?? null, discord: !!discordConfig() }));

  route('POST', '/api/auth/guest', async (ctx) => {
    const { name } = await readJson<{ name?: string }>(ctx.req);
    const clean = (name ?? '').trim();
    if (!clean) throw new HttpError(400, 'pick a name');
    const { user, token } = store.createUser(clean);
    ctx.res.setHeader('set-cookie', tokenCookie(token));
    return { user, token };
  });

  route('PATCH', '/api/me', async (ctx) => {
    const user = needUser(ctx);
    const { name } = await readJson<{ name?: string }>(ctx.req);
    if (name?.trim()) store.updateUser(user.id, { name: name.trim() });
    return { user: store.user(user.id) };
  });

  route('POST', '/api/auth/logout', (ctx) => {
    ctx.res.setHeader('set-cookie', 'll_token=; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/auth/discord', (ctx) => {
    const cfg = discordConfig();
    if (!cfg) throw new HttpError(404, 'Discord login is not configured');
    // State carries the current user (to link accounts) and where to go afterwards.
    const state = Buffer.from(JSON.stringify({ link: ctx.user?.id, next: ctx.query.get('next') ?? '/' })).toString('base64url');
    ctx.res.writeHead(302, { location: discordAuthorizeUrl(cfg, state) });
    ctx.res.end();
  });

  route('GET', '/api/auth/discord/callback', async (ctx) => {
    const cfg = discordConfig();
    if (!cfg) throw new HttpError(404, 'Discord login is not configured');
    const code = ctx.query.get('code');
    if (!code) throw new HttpError(400, 'missing code');
    let state: { link?: string; next?: string } = {};
    try {
      state = JSON.parse(Buffer.from(ctx.query.get('state') ?? '', 'base64url').toString());
    } catch { /* ignore malformed state */ }
    const d = await discordExchange(cfg, code);
    let user = store.userByDiscord(d.id);
    let token: string;
    if (user) {
      token = store.rotateToken(user.id);
    } else if (state.link && store.user(state.link) && ctx.user?.id === state.link) {
      store.updateUser(state.link, { discordId: d.id, avatar: d.avatar });
      user = store.user(state.link)!;
      token = store.rotateToken(user.id);
    } else {
      const created = store.createUser(d.name, { discordId: d.id, avatar: d.avatar });
      user = created.user;
      token = created.token;
    }
    const next = state.next?.startsWith('/') ? state.next : '/';
    ctx.res.writeHead(302, { 'set-cookie': tokenCookie(token), location: `${next}${next.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` });
    ctx.res.end();
  });

  // ---- runs
  route('GET', '/api/runs', (ctx) => ({ runs: store.runsForUser(needUser(ctx).id) }));

  route('POST', '/api/runs', async (ctx) => {
    const user = needUser(ctx);
    const body = await readJson<{ name?: string; profileId?: string; gameName?: string; romSha1?: string; preset?: PresetName; settings?: RuleSettings; maxPlayers?: number }>(ctx.req);
    const settings = body.settings ?? PRESETS[body.preset ?? 'classic'] ?? PRESETS.classic;
    const run = store.createRun(user, {
      name: body.name?.trim() || `${user.name}'s Soul Link`,
      profileId: body.profileId,
      gameName: body.gameName,
      romSha1: body.romSha1,
      settings,
      maxPlayers: body.maxPlayers ?? 2,
    });
    const player = store.addPlayer(run.id, user);
    appendSettings(run.id, settings, body.profileId);
    rooms.appendSystem(run.id, { kind: 'player-join', playerId: player.playerId, name: user.name });
    return { run };
  });

  route('GET', '/api/invite/:code', (ctx) => {
    const run = store.runByInvite(ctx.params.code);
    if (!run) throw new HttpError(404, 'invite not found');
    const { overlayKey: _hidden, ...pub } = run;
    return { run: pub, players: store.players(run.id) };
  });

  route('POST', '/api/invite/:code/join', (ctx) => {
    const user = needUser(ctx);
    const run = store.runByInvite(ctx.params.code);
    if (!run) throw new HttpError(404, 'invite not found');
    const existing = store.playerFor(run.id, user.id);
    if (existing) return { run };
    const players = store.players(run.id);
    if (players.length >= run.maxPlayers) throw new HttpError(409, 'this run is full');
    if (run.status !== 'lobby' && run.status !== 'active') throw new HttpError(409, 'this run has ended');
    const player = store.addPlayer(run.id, user);
    rooms.appendSystem(run.id, { kind: 'player-join', playerId: player.playerId, name: user.name });
    rooms.broadcastRun(run.id);
    return { run };
  });

  route('GET', '/api/runs/:id', (ctx) => {
    const { run } = needMember(ctx, ctx.params.id);
    return { run, players: store.players(run.id) };
  });

  route('PATCH', '/api/runs/:id', async (ctx) => {
    const { run, user } = needMember(ctx, ctx.params.id);
    if (run.ownerId !== user.id) throw new HttpError(403, 'only the run owner can change settings');
    const body = await readJson<{ name?: string; settings?: RuleSettings; status?: 'active'; webhookUrl?: string | null; profileId?: string; gameName?: string }>(ctx.req);
    if (body.webhookUrl && !/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(body.webhookUrl)) throw new HttpError(400, 'that is not a Discord webhook URL');
    store.updateRun(run.id, { name: body.name, settings: body.settings, status: body.status, webhookUrl: body.webhookUrl, profileId: body.profileId, gameName: body.gameName });
    if (body.settings || body.profileId) appendSettings(run.id, body.settings ?? run.settings, body.profileId ?? run.profileId);
    rooms.broadcastRun(run.id);
    return { run: store.run(run.id) };
  });

  route('GET', '/api/runs/:id/log', (ctx) => {
    needMember(ctx, ctx.params.id);
    return { log: rooms.log(ctx.params.id) };
  });

  route('GET', '/api/runs/:id/stats', (ctx) => {
    const run = store.run(ctx.params.id);
    if (!run) throw new HttpError(404, 'run not found');
    // Finished runs' recaps are public (hall of fame); live runs need membership or the overlay key.
    if (run.status === 'active' || run.status === 'lobby') {
      if (ctx.query.get('key') !== run.overlayKey) needMember(ctx, run.id);
    }
    const { overlayKey: _hidden, ...pub } = run;
    return { run: pub, players: store.players(run.id), stats: runStats(rooms.log(run.id)), state: rooms.state(run.id) };
  });

  route('GET', '/api/hall-of-fame', () => {
    const runs = store.runsByStatus('won').map(({ overlayKey: _h, ...r }) => ({ ...r, players: store.players(r.id), stats: runStats(rooms.log(r.id)) }));
    const fallen = store.runsByStatus('failed', 20).map(({ overlayKey: _h, ...r }) => ({ ...r, players: store.players(r.id), stats: runStats(rooms.log(r.id)) }));
    return { runs, fallen };
  });

  // ---- cloud saves
  route('GET', '/api/runs/:id/saves', (ctx) => {
    needMember(ctx, ctx.params.id);
    return { saves: store.saves(ctx.params.id, ctx.query.get('player') ?? undefined) };
  });

  route('PUT', '/api/runs/:id/saves', async (ctx) => {
    const { player } = needMember(ctx, ctx.params.id);
    const data = new Uint8Array(await readBody(ctx.req, 2 * 1024 * 1024));
    if (!data.length) throw new HttpError(400, 'empty save');
    const label = (ctx.req.headers['x-save-label'] as string | undefined)?.slice(0, 64);
    const save = store.addSave(ctx.params.id, player.playerId, data, sha1(data), label);
    if (save) rooms.broadcast(ctx.params.id, { t: 'save', save });
    return { save: save ?? null, unchanged: !save };
  });

  route('GET', '/api/runs/:id/saves/:sid', (ctx) => {
    needMember(ctx, ctx.params.id);
    const data = store.saveData(ctx.params.id, ctx.params.sid);
    if (!data) throw new HttpError(404, 'save not found');
    ctx.res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    ctx.res.end(Buffer.from(data));
  });

  // ---- community game profiles (ROM hacks)
  route('GET', '/api/profiles', () => ({ profiles: store.profiles() }));

  route('PUT', '/api/profiles/:id', async (ctx) => {
    const user = needUser(ctx);
    const p = await readJson<GameProfile>(ctx.req);
    if (p.id !== ctx.params.id || !p.name || !p.engine) throw new HttpError(400, 'profile needs id, name and engine');
    if (new ProfileRegistry().raw(p.id)) throw new HttpError(409, 'built-in profiles can’t be overwritten; use a new id that extends it');
    const owner = store.profileOwner(p.id);
    if (owner && owner !== user.id) throw new HttpError(403, 'someone else owns this profile id');
    // Validate inheritance before saving.
    const r = registry();
    r.add(p);
    r.resolve(p.id);
    store.saveProfile(user.id, p);
    return { profile: p };
  });

  route('DELETE', '/api/profiles/:id', (ctx) => {
    const user = needUser(ctx);
    if (store.profileOwner(ctx.params.id) !== user.id) throw new HttpError(403, 'not your profile');
    store.deleteProfile(ctx.params.id);
    return { ok: true };
  });

  route('GET', '/api/health', () => ({ ok: true }));

  // ---- static frontend (production)
  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if (!staticDir) return false;
    const url = new URL(req.url ?? '/', 'http://x');
    let file = normalize(join(staticDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(staticDir)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, 'index.html'); // SPA fallback
    if (!existsSync(file)) return false;
    const ext = extname(file);
    const immutable = file.includes(`${join(staticDir, 'assets')}`) || ext === '.wasm';
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(req, res)) return;
      return json(res, 404, { error: 'not found' });
    }
    const m = url.pathname.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const ctx: Ctx = { req, res, params, query: url.searchParams, user: store.userByToken(bearer(req)) };
    try {
      const out = await r.handler(ctx);
      if (!res.headersSent && out !== undefined) json(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
    }
  };
}
