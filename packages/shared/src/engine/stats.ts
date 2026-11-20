/** End-of-run statistics, derived purely from the log (used for the recap and hall of fame). */
import { buildRunState } from './reducer';
import type { LogEntry, PlayerId, RunMon } from './types';
import type { DeathCause } from '../tracking/events';

export interface GraveEntry {
  uid: string;
  owner: PlayerId;
  species: number;
  nickname: string;
  level: number;
  area: string;
  place?: string;
  cause?: DeathCause;
  at: number;
  /** Died because a linked partner died (not by fainting itself). */
  linkDeath: boolean;
}

export interface CloseCall {
  owner: PlayerId;
  uid: string;
  species: number;
  nickname: string;
  hp: number;
  maxHp: number;
  place: string;
  at: number;
}

export interface RunStats {
  durationMs: number;
  startedAt?: number;
  endedAt?: number;
  perPlayer: Record<PlayerId, { catches: number; failed: number; deaths: number; badges: number; trainerWins: number; wipes: number }>;
  graveyard: GraveEntry[];
  links: { total: number; alive: number; dead: number; failed: number };
  /** Pokémon with the most trainer-battle wins while in the party. */
  mvp?: { uid: string; owner: PlayerId; species: number; nickname: string; level: number; wins: number };
  closestCalls: CloseCall[];
  encounters: number;
}

export function runStats(log: LogEntry[]): RunStats {
  const state = buildRunState(log);
  const voided = new Set(state.voided);
  const live = log.filter((e) => !voided.has(e.seq)).sort((a, b) => a.seq - b.seq);
  const perPlayer: RunStats['perPlayer'] = {};
  for (const id of Object.keys(state.players)) {
    const p = state.players[id];
    perPlayer[id] = {
      catches: Object.values(state.mons).filter((m) => m.owner === id && m.status !== 'extra').length,
      failed: Object.values(p.encounters).filter((e) => e.status === 'failed').length,
      deaths: Object.values(state.mons).filter((m) => m.owner === id && m.status === 'dead').length,
      badges: p.badges,
      trainerWins: 0,
      wipes: p.wipes,
    };
  }

  const party = new Map<PlayerId, string[]>();
  const wins = new Map<string, number>();
  const closestCalls: CloseCall[] = [];
  for (const e of live) {
    if (e.kind === 'action' && e.action.type === 'party') party.set(e.playerId, e.action.members.map((m) => m.uid));
    if (e.kind === 'tracker' && e.event.type === 'trainer-battle' && e.event.result === 'won') {
      perPlayer[e.playerId] && perPlayer[e.playerId].trainerWins++;
      for (const uid of party.get(e.playerId) ?? []) wins.set(uid, (wins.get(uid) ?? 0) + 1);
    }
    if (e.kind === 'tracker' && e.event.type === 'close-call') {
      const ev = e.event;
      closestCalls.push({ owner: e.playerId, uid: ev.mon.uid, species: ev.mon.species, nickname: ev.mon.nickname, hp: ev.hp, maxHp: ev.maxHp, place: ev.place.area, at: e.at });
    }
  }
  closestCalls.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.hp - b.hp);

  const graveyard: GraveEntry[] = Object.values(state.mons)
    .filter((m) => m.status === 'dead' || m.status === 'link-dead')
    .map((m: RunMon) => {
      const linkDeathAt = m.status === 'link-dead' ? deathTimeOfPartner(state.mons, state.links[m.linkId ?? '']?.members ?? {}, m.uid) : undefined;
      return {
        uid: m.uid, owner: m.owner, species: m.species, nickname: m.nickname, level: m.death?.level ?? m.level, area: m.area,
        place: m.death?.place, cause: m.death?.cause, at: m.death?.at ?? linkDeathAt ?? 0, linkDeath: m.status === 'link-dead',
      };
    })
    .sort((a, b) => a.at - b.at);

  let mvp: RunStats['mvp'];
  for (const [uid, w] of wins) {
    const m = state.mons[uid];
    if (!m || m.status === 'extra') continue;
    if (!mvp || w > mvp.wins || (w === mvp.wins && m.level > mvp.level)) mvp = { uid, owner: m.owner, species: m.species, nickname: m.nickname, level: m.level, wins: w };
  }

  const links = Object.values(state.links);
  const startedAt = live[0]?.at;
  const endedAt = live.at(-1)?.at;
  return {
    durationMs: startedAt && endedAt ? endedAt - startedAt : 0,
    startedAt,
    endedAt,
    perPlayer,
    graveyard,
    links: {
      total: links.filter((l) => l.status !== 'pending').length,
      alive: links.filter((l) => l.status === 'alive').length,
      dead: links.filter((l) => l.status === 'dead').length,
      failed: links.filter((l) => l.status === 'failed' || l.status === 'orphaned').length,
    },
    mvp,
    closestCalls: closestCalls.slice(0, 5),
    encounters: state.areaOrder.length,
  };
}

function deathTimeOfPartner(mons: Record<string, RunMon>, members: Record<string, string | null>, self: string) {
  return Object.values(members)
    .filter((u): u is string => !!u && u !== self)
    .map((u) => mons[u]?.death?.at)
    .find((t) => t !== undefined);
}
