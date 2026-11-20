import { useSyncExternalStore } from 'react';
import { buildRunState } from '@leelink/shared/engine/reducer';
import type { LogEntry, LogEntryInput, RunState } from '@leelink/shared/engine/types';
import type { ChatMessage, ClientMessage, Presence, RunPlayer, RunSummary, SaveVersion, ServerMessage, UserInfo } from '@leelink/shared/protocol';
import { getToken } from './api';

export interface ConnectionSnapshot {
  status: 'connecting' | 'online' | 'offline' | 'error';
  error?: string;
  me?: string;
  user?: UserInfo;
  run?: RunSummary;
  players: RunPlayer[];
  log: LogEntry[];
  state?: RunState;
  presence: Record<string, Presence>;
  chat: ChatMessage[];
  frames: Record<string, string>;
  lastSave?: SaveVersion;
  /** Entries sent but not yet acknowledged (shown as "syncing"). */
  pending: number;
}

let cidCounter = 0;
const newCid = () => `${Date.now().toString(36)}-${(cidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Live connection to a run room. Keeps the authoritative log from the server and derives
 * run state locally with the same pure engine the server uses.
 * Appends made while offline are queued and retried with idempotent client ids.
 */
export class RunConnection {
  private ws?: WebSocket;
  private listeners = new Set<() => void>();
  private outbox = new Map<string, LogEntryInput>();
  private retry = 0;
  private closed = false;
  private stateCacheSeq = -1;
  private pingTimer?: ReturnType<typeof setInterval>;
  snap: ConnectionSnapshot = { status: 'connecting', players: [], log: [], presence: {}, chat: [], frames: {}, pending: 0 };
  onEntry?: (entry: LogEntry, mine: boolean) => void;

  constructor(readonly runId: string, private readonly overlayKey?: string) {
    this.connect();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<ConnectionSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    if (patch.log) {
      const last = patch.log.at(-1)?.seq ?? 0;
      if (last !== this.stateCacheSeq) {
        this.stateCacheSeq = last;
        this.snap.state = buildRunState(patch.log);
      }
    }
    this.listeners.forEach((l) => l());
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', runId: this.runId, token: this.overlayKey ?? getToken() ?? '' } satisfies ClientMessage));
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data) as ServerMessage);
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.set({ status: this.snap.status === 'error' ? 'error' : 'offline' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private handle(m: ServerMessage) {
    switch (m.t) {
      case 'welcome': {
        this.retry = 0;
        const presence = Object.fromEntries(m.presence.map((p) => [p.playerId, p]));
        this.set({ status: 'online', error: undefined, me: m.me || undefined, user: m.user, run: m.run, players: m.players, log: m.log, presence, chat: m.chat });
        // Flush anything queued while offline (server dedupes by client id).
        for (const [cid, entry] of this.outbox) this.ws?.send(JSON.stringify({ t: 'append', entry, clientId: cid } satisfies ClientMessage));
        this.pingTimer = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send('{"t":"ping"}'), 25_000);
        break;
      }
      case 'entry': {
        const mine = !!m.clientId && this.outbox.delete(m.clientId);
        if (this.snap.log.some((e) => e.seq === m.entry.seq)) {
          this.set({ pending: this.outbox.size });
          break;
        }
        this.set({ log: [...this.snap.log, m.entry], pending: this.outbox.size });
        this.onEntry?.(m.entry, mine);
        break;
      }
      case 'run':
        this.set({ run: m.run, players: m.players });
        break;
      case 'presence':
        this.set({ presence: { ...this.snap.presence, [m.presence.playerId]: m.presence } });
        break;
      case 'chat':
        this.set({ chat: [...this.snap.chat.slice(-199), m.message] });
        break;
      case 'frame':
        this.set({ frames: { ...this.snap.frames, [m.playerId]: m.data } });
        break;
      case 'save':
        this.set({ lastSave: m.save });
        break;
      case 'error':
        if (this.snap.status !== 'online') this.set({ status: 'error', error: m.message });
        else console.warn('server:', m.message);
        break;
    }
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  append(entry: LogEntryInput) {
    const cid = newCid();
    this.outbox.set(cid, entry);
    this.set({ pending: this.outbox.size });
    this.send({ t: 'append', entry, clientId: cid });
  }

  presence(p: Extract<ClientMessage, { t: 'presence' }>['presence']) {
    this.send({ t: 'presence', presence: p });
  }
  chat(text: string) {
    this.send({ t: 'chat', text });
  }
  react(emoji: string) {
    this.send({ t: 'react', emoji });
  }
  frame(data: string) {
    this.send({ t: 'frame', data });
  }
  watchFrames(on: boolean) {
    this.send({ t: 'watch-frames', on });
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

export function useConnection(conn: RunConnection | undefined): ConnectionSnapshot | undefined {
  return useSyncExternalStore(conn?.subscribe ?? noopSubscribe, conn ? conn.getSnapshot : noopSnapshot);
}
const noopSubscribe = () => () => undefined;
const noopSnapshot = () => undefined;
