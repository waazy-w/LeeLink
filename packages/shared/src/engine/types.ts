import type { LevelCap } from '../profiles/types';
import type { DeathCause, MonRef, TrackerEvent } from '../tracking/events';
import type { RuleSettings } from './settings';

export type PlayerId = string;

/** Actions players take by hand: manual mode, rule tools and run management. */
export type PlayerAction =
  | { type: 'manual-encounter'; area: string; species: number; level?: number; nickname?: string; result: 'caught' | 'failed' }
  | { type: 'manual-death'; uid: string; cause?: DeathCause }
  | { type: 'manual-badge'; count: number }
  | { type: 'manual-location'; area: string }
  /** Current party composition in slot order. Sent by trackers when it changes. */
  | { type: 'party'; members: PartyMember[] }
  | { type: 'use-retry'; area: string }
  | { type: 'use-revive'; linkId: string }
  | { type: 'finish-run'; result: 'won' | 'abandoned' };

export interface PartyMember {
  uid: string;
  species: number;
  level: number;
  nickname: string;
  hp?: number;
}

export interface GameInfo {
  profileId?: string;
  generation: number;
  /** Hack retypes (national dex -> types). */
  typeOverrides?: Record<string, string[]>;
}

/** One append-only log record. The whole run state is a pure function of the log. */
export type LogEntry = { seq: number; at: number; /** Client-generated id; makes retries idempotent. */ cid?: string } & (
  | { kind: 'player-join'; playerId: PlayerId; name: string }
  | { kind: 'settings'; settings: RuleSettings; levelCaps?: LevelCap[]; game?: GameInfo }
  | { kind: 'tracker'; playerId: PlayerId; event: TrackerEvent }
  | { kind: 'action'; playerId: PlayerId; action: PlayerAction }
  /** Voids `target` (or restores it, if `target` is itself an undo). */
  | { kind: 'undo'; playerId: PlayerId; target: number }
  | { kind: 'dispute-open'; playerId: PlayerId; disputeId: string; target: number; reason: string }
  | { kind: 'dispute-vote'; playerId: PlayerId; disputeId: string; approve: boolean }
);

export type LogEntryInput = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, 'seq' | 'at'> : never) : never;

export type MonStatus =
  /** In a complete, living link (or unlinked and alive). */
  | 'alive'
  /** Fainted: dead for the rest of the run. */
  | 'dead'
  /** Partner died: must be boxed/released, can't be used. */
  | 'link-dead'
  /** Link failed (classic): partners' catch can't be used. */
  | 'link-failed'
  /** Waiting for partners to resolve the area. */
  | 'pending'
  /** Orphan mode: boxed until a later link can adopt it. */
  | 'orphan'
  /** Not part of the run (dupe, second catch on an area, gift when gifts don't count). */
  | 'extra';

export interface RunMon {
  uid: string;
  owner: PlayerId;
  species: number;
  nickname: string;
  level: number;
  area: string;
  origin: 'caught' | 'gift' | 'manual';
  status: MonStatus;
  linkId?: string;
  death?: { seq: number; at: number; place?: string; cause?: DeathCause; level: number };
  obtainedSeq: number;
}

export interface AreaEncounter {
  species: number;
  level: number;
  /** pending: battle in progress; caught/failed once resolved; skipped: dupe/shiny clause. */
  status: 'pending' | 'caught' | 'failed' | 'skipped';
  uid?: string;
  seq: number;
}

export interface Link {
  id: string;
  area: string;
  /** uid per player; null = that player failed this area. */
  members: Record<PlayerId, string | null>;
  status: 'pending' | 'alive' | 'dead' | 'failed' | 'orphaned';
  createdSeq: number;
  /** Revived with a shard. */
  revived?: boolean;
}

export interface Warning {
  seq: number;
  at: number;
  playerId: PlayerId;
  code:
    | 'dead-in-party'
    | 'partner-not-in-party'
    | 'unusable-in-party'
    | 'second-catch'
    | 'dupe'
    | 'type-clause'
    | 'over-level-cap'
    | 'shiny';
  message: string;
  /** True for warnings about an encounter that's in progress (before the catch is confirmed). */
  preCatch?: boolean;
}

export interface Alert {
  seq: number;
  at: number;
  kind: 'link-death' | 'wipe' | 'run-over' | 'link-formed' | 'link-failed' | 'badge' | 'gate-open';
  /** Players who must act (e.g. box a Pokémon). Empty = everyone, informational. */
  players: PlayerId[];
  message: string;
  linkId?: string;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  trainer?: { name: string; id: number };
  badges: number;
  location?: string;
  party: PartyMember[];
  /** Area -> this player's first counted encounter. */
  encounters: Record<string, AreaEncounter>;
  retryUsed: number;
  wipes: number;
  hadFirstEncounter: boolean;
}

export interface Dispute {
  id: string;
  target: number;
  reason: string;
  openedBy: PlayerId;
  votes: Record<PlayerId, boolean>;
  status: 'open' | 'accepted' | 'rejected';
  seq: number;
}

export interface FeedItem {
  seq: number;
  at: number;
  playerId?: PlayerId;
  kind: 'catch' | 'fail' | 'death' | 'badge' | 'warning' | 'link' | 'wipe' | 'dispute' | 'undo' | 'info';
  text: string;
}

export interface RunState {
  settings: RuleSettings;
  levelCaps: LevelCap[];
  game: GameInfo;
  players: Record<PlayerId, PlayerState>;
  mons: Record<string, RunMon>;
  links: Record<string, Link>;
  /** Area keys in the order they were first encountered. */
  areaOrder: string[];
  warnings: Warning[];
  alerts: Alert[];
  feed: FeedItem[];
  disputes: Record<string, Dispute>;
  /** Log seqs currently voided by undo or accepted disputes. */
  voided: number[];
  reviveShards: { earned: number; used: number };
  status: 'active' | 'won' | 'failed' | 'abandoned';
  lastSeq: number;
}

export type { MonRef };
