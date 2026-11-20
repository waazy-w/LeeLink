import type { WebSocket } from 'ws';
import { buildRunState } from '@leelink/shared/engine/reducer';
import type { LogEntry, LogEntryInput, RunState } from '@leelink/shared/engine/types';
import type { ClientMessage, Presence, ServerMessage, UserInfo } from '@leelink/shared/protocol';
import type { Store } from './store';
import { notifyDiscord } from './discord';

interface Client {
  ws: WebSocket;
  user?: UserInfo;
  playerId?: string;
  readOnly: boolean;
  watchFrames: boolean;
}

const CLIENT_KINDS = new Set(['tracker', 'action', 'undo', 'dispute-open', 'dispute-vote']);

/** One live room per run: connected sockets, presence, and the authoritative run state. */
class Room {
  clients = new Set<Client>();
  presence = new Map<string, Presence>();
  private state?: RunState;
  private log?: LogEntry[];

  constructor(readonly runId: string, private readonly store: Store) {}

  getLog() {
    this.log ??= this.store.log(this.runId);
    return this.log;
  }

  getState(): RunState {
    this.state ??= buildRunState(this.getLog());
    return this.state;
  }

  send(c: Client, msg: ServerMessage) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage, filter: (c: Client) => boolean = () => true) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (filter(c) && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  /** Validates and appends an entry, then broadcasts it. The server owns ordering (seq). */
  append(input: LogEntryInput, clientId?: string): LogEntry {
    const before = this.getState();
    const entry = this.store.append(this.runId, input);
    this.getLog().push(entry);
    this.state = buildRunState(this.log!);
    this.broadcast({ t: 'entry', entry, clientId });
    this.afterAppend(before, this.state);
    return entry;
  }

  private afterAppend(before: RunState, after: RunState) {
    const run = this.store.run(this.runId);
    if (!run) return;
    // Keep the run's status column in sync with the engine (for history / hall of fame).
    if (after.status !== 'active' && run.status !== after.status) {
      this.store.updateRun(this.runId, { status: after.status });
      this.broadcast({ t: 'run', run: this.store.run(this.runId)!, players: this.store.players(this.runId) });
    }
    const url = this.store.webhookUrl(this.runId);
    if (url) {
      const newFeed = after.feed.filter((f) => f.seq > before.lastSeq && ['death', 'badge', 'wipe', 'link'].includes(f.kind));
      const ended = after.status !== before.status && after.status !== 'active';
      if (newFeed.length || ended) void notifyDiscord(url, run.name, newFeed, ended ? after.status : undefined);
    }
  }

  presenceList(): Presence[] {
    const online = new Set([...this.clients].filter((c) => c.playerId).map((c) => c.playerId!));
    return this.store.players(this.runId).map((p) => {
      const pr = this.presence.get(p.playerId);
      return { ...(pr ?? { playerId: p.playerId, updatedAt: 0 }), playerId: p.playerId, online: online.has(p.playerId) };
    });
  }
}

export class Rooms {
  private rooms = new Map<string, Room>();

  constructor(private readonly store: Store) {}

  room(runId: string): Room {
    let r = this.rooms.get(runId);
    if (!r) {
      r = new Room(runId, this.store);
      this.rooms.set(runId, r);
    }
    return r;
  }

  /** Server-originated entries (player joins, settings changes). */
  appendSystem(runId: string, input: LogEntryInput) {
    return this.room(runId).append(input);
  }

  state(runId: string) {
    return this.room(runId).getState();
  }

  log(runId: string) {
    return this.room(runId).getLog();
  }

  presence(runId: string) {
    return this.room(runId).presenceList();
  }

  broadcastRun(runId: string) {
    const run = this.store.run(runId);
    if (run) this.room(runId).broadcast({ t: 'run', run, players: this.store.players(runId) });
  }

  broadcast(runId: string, msg: ServerMessage) {
    this.room(runId).broadcast(msg);
  }

  /** Attaches a websocket: first message must be `hello` (player token or overlay key). */
  attach(ws: WebSocket) {
    const client: Client = { ws, readOnly: true, watchFrames: false };
    let room: Room | undefined;
    const fail = (message: string) => {
      ws.send(JSON.stringify({ t: 'error', message } satisfies ServerMessage));
    };

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail('bad message');
      }
      if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));

      if (msg.t === 'hello') {
        const run = this.store.run(msg.runId);
        if (!run) return fail('run not found');
        const user = this.store.userByToken(msg.token);
        const player = user ? this.store.playerFor(run.id, user.id) : undefined;
        if (player && user) {
          client.user = user;
          client.playerId = player.playerId;
          client.readOnly = false;
        } else if (msg.token !== run.overlayKey) {
          return fail('not a member of this run');
        }
        room = this.room(run.id);
        room.clients.add(client);
        room.send(client, {
          t: 'welcome',
          me: client.playerId ?? '',
          user: client.user ?? { id: '', name: 'Overlay' },
          run,
          players: this.store.players(run.id),
          log: room.getLog(),
          presence: room.presenceList(),
          chat: this.store.chat(run.id),
        });
        if (client.playerId) this.pushPresence(room, client.playerId, {});
        return;
      }

      if (!room) return fail('say hello first');
      if (msg.t === 'watch-frames') {
        client.watchFrames = msg.on;
        return;
      }
      if (client.readOnly || !client.playerId) return fail('read-only connection');
      const pid = client.playerId;

      switch (msg.t) {
        case 'append': {
          const e = msg.entry as LogEntryInput & { playerId?: string };
          // Retried after a reconnect: already stored, just acknowledge.
          if (msg.clientId && room.getLog().some((x) => x.cid === msg.clientId)) {
            const existing = room.getLog().find((x) => x.cid === msg.clientId)!;
            room.send(client, { t: 'entry', entry: existing, clientId: msg.clientId });
            return;
          }
          if (!CLIENT_KINDS.has(e.kind)) return fail(`clients can't append ${e.kind}`);
          const input = { ...e, playerId: pid } as LogEntryInput;
          if (input.kind === 'undo') {
            const target = room.getLog().find((x) => x.seq === input.target);
            if (!target) return fail('nothing to undo');
            // You can undo your own entries; other players' entries need a dispute vote.
            if ('playerId' in target && target.playerId !== pid) return fail("open a dispute to undo another player's event");
          }
          if (input.kind === 'dispute-open' && !room.getLog().some((x) => x.seq === input.target)) return fail('unknown event');
          room.append(msg.clientId ? ({ ...input, cid: msg.clientId } as LogEntryInput) : input, msg.clientId);
          return;
        }
        case 'presence':
          this.pushPresence(room, pid, msg.presence);
          if (msg.presence.romSha1) this.checkRom(room, msg.presence.romSha1);
          return;
        case 'chat':
        case 'react': {
          const text = msg.t === 'chat' ? msg.text.trim() : msg.emoji;
          if (!text) return;
          const message = this.store.addChat(room.runId, pid, text, msg.t === 'chat' ? 'chat' : 'reaction');
          room.broadcast({ t: 'chat', message });
          return;
        }
        case 'frame':
          if (msg.data.length > 200_000) return;
          room.broadcast({ t: 'frame', playerId: pid, data: msg.data }, (c) => c.watchFrames && c !== client);
          return;
      }
    });

    ws.on('close', () => {
      if (!room) return;
      room.clients.delete(client);
      if (client.playerId && ![...room.clients].some((c) => c.playerId === client.playerId)) this.pushPresence(room, client.playerId, {});
    });
  }

  private pushPresence(room: Room, playerId: string, patch: Partial<Presence>) {
    const prev = room.presence.get(playerId) ?? { playerId, online: true, updatedAt: 0 };
    const online = [...room.clients].some((c) => c.playerId === playerId);
    const next: Presence = { ...prev, ...patch, playerId, online, updatedAt: Date.now() };
    room.presence.set(playerId, next);
    room.broadcast({ t: 'presence', presence: next });
  }

  /** The first ROM loaded in a run becomes the run's reference hash. */
  private checkRom(room: Room, sha1: string) {
    const run = this.store.run(room.runId);
    if (run && !run.romSha1) {
      this.store.updateRun(run.id, { romSha1: sha1 });
      this.broadcastRun(run.id);
    }
  }
}
