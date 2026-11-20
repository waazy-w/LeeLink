/** WebSocket + HTTP protocol shared by the server and the web app. */
import type { LogEntry, LogEntryInput, PlayerId } from './engine/types';
import type { RuleSettings } from './engine/settings';
import type { MajorStatus } from './model';

export interface UserInfo {
  id: string;
  name: string;
  avatar?: string;
  discord?: boolean;
}

export interface RunSummary {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  profileId?: string;
  gameName?: string;
  /** ROM hash every player must match (set by the creator's ROM, or the first player to load one). */
  romSha1?: string;
  status: 'lobby' | 'active' | 'won' | 'failed' | 'abandoned';
  createdAt: number;
  maxPlayers: number;
  settings: RuleSettings;
  hasWebhook?: boolean;
  overlayKey?: string;
}

export interface RunPlayer {
  playerId: PlayerId;
  user: UserInfo;
  joinedAt: number;
  color: string;
}

/** Live, high-frequency per-player status. Not part of the log. */
export interface Presence {
  playerId: PlayerId;
  online: boolean;
  romSha1?: string;
  romTitle?: string;
  mode?: 'auto' | 'manual';
  location?: string;
  badges?: number;
  inBattle?: boolean;
  party?: { uid: string; species: number; nickname: string; level: number; hp?: number; maxHp?: number; status: MajorStatus }[];
  playTimeSec?: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  playerId: PlayerId;
  at: number;
  text: string;
  kind: 'chat' | 'reaction';
}

export interface SaveVersion {
  id: string;
  playerId: PlayerId;
  version: number;
  createdAt: number;
  size: number;
  sha1: string;
  label?: string;
}

export type ClientMessage =
  | { t: 'hello'; runId: string; token: string }
  | { t: 'append'; entry: LogEntryInput; clientId?: string }
  | { t: 'presence'; presence: Omit<Presence, 'playerId' | 'online' | 'updatedAt'> }
  | { t: 'chat'; text: string }
  | { t: 'react'; emoji: string }
  /** JPEG data URL of the player's screen, for live previews. */
  | { t: 'frame'; data: string }
  | { t: 'watch-frames'; on: boolean }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; me: PlayerId; user: UserInfo; run: RunSummary; players: RunPlayer[]; log: LogEntry[]; presence: Presence[]; chat: ChatMessage[] }
  | { t: 'entry'; entry: LogEntry; clientId?: string }
  | { t: 'run'; run: RunSummary; players: RunPlayer[] }
  | { t: 'presence'; presence: Presence }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'frame'; playerId: PlayerId; data: string }
  | { t: 'save'; save: SaveVersion }
  | { t: 'error'; message: string }
  | { t: 'pong' };

export const PLAYER_COLORS = ['#f43f5e', '#38bdf8', '#a3e635', '#fbbf24'];
