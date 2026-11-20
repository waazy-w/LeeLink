import { describe, expect, it } from 'vitest';
import { buildRunState, pacing, currentLevelCap, teamOptions, STARTER_AREA } from './reducer';
import { PRESETS, type RuleSettings } from './settings';
import type { LogEntry, LogEntryInput, PlayerAction } from './types';
import type { TrackerEvent, PlaceRef } from '../tracking/events';
import type { PokemonData } from '../model';

// ---- log builder -----------------------------------------------------------------------------

class Log {
  entries: LogEntry[] = [];
  push(e: LogEntryInput): number {
    const seq = this.entries.length + 1;
    this.entries.push({ ...e, seq, at: seq * 1000 } as LogEntry);
    return seq;
  }
  join(...names: string[]) {
    names.forEach((n) => this.push({ kind: 'player-join', playerId: n, name: n }));
    return this;
  }
  settings(over: Partial<RuleSettings> = {}, extra: Partial<Extract<LogEntryInput, { kind: 'settings' }>> = {}) {
    this.push({ kind: 'settings', settings: { ...PRESETS.classic, ...over }, ...extra });
    return this;
  }
  ev(playerId: string, event: TrackerEvent) {
    return this.push({ kind: 'tracker', playerId, event });
  }
  act(playerId: string, action: PlayerAction) {
    return this.push({ kind: 'action', playerId, action });
  }
  state() {
    return buildRunState(this.entries);
  }

  // Convenience: full wild encounter flows.
  catch(pid: string, area: string, species: number, uid = `${pid}-${area}-${species}`, level = 5) {
    const place = P(area);
    this.ev(pid, { type: 'encounter', place, species, level });
    this.ev(pid, { type: 'encounter-end', place, species, level, result: 'caught' });
    this.ev(pid, { type: 'obtained', place, mon: mon(uid, species, level), method: 'caught' });
    return uid;
  }
  fail(pid: string, area: string, species: number, result: 'ran' | 'won' | 'fled' = 'ran') {
    const place = P(area);
    this.ev(pid, { type: 'encounter', place, species, level: 3 });
    this.ev(pid, { type: 'encounter-end', place, species, level: 3, result });
  }
  starter(pid: string, species: number) {
    const uid = `${pid}-starter`;
    this.ev(pid, { type: 'obtained', place: P('Pallet Town'), mon: mon(uid, species), method: 'gift' });
    return uid;
  }
  faint(pid: string, uid: string, species = 1, cause: TrackerEvent & { type: 'faint' } extends { cause: infer C } ? C : never = { kind: 'wild', enemySpecies: 19, enemyLevel: 4 }) {
    this.ev(pid, { type: 'faint', place: P('Route 2'), mon: { uid, species, nickname: '', level: 5 }, cause });
  }
  party(pid: string, members: { uid: string; species: number; level?: number }[]) {
    this.act(pid, { type: 'party', members: members.map((m) => ({ uid: m.uid, species: m.species, level: m.level ?? 5, nickname: '' })) });
  }
}

const P = (area: string): PlaceRef => ({ id: 0, name: area, area });
const mon = (uid: string, species: number, level = 5): PokemonData => ({
  uid, species, nickname: '', level, hp: 20, maxHp: 20, status: 'ok', isEgg: false, otId: 1, heldItem: 0, moves: [], experience: 0,
});
const twoPlayer = (over: Partial<RuleSettings> = {}) => new Log().join('ash', 'misty').settings(over);

// ---- tests -------------------------------------------------------------------------------------

describe('linking', () => {
  it('links each player’s first encounter on an area', () => {
    const log = twoPlayer();
    const a = log.catch('ash', 'Route 1', 16);
    const s1 = log.state();
    expect(s1.links['link:Route 1'].status).toBe('pending');
    expect(s1.mons[a].status).toBe('pending');
    const b = log.catch('misty', 'Route 1', 19);
    const s = log.state();
    expect(s.links['link:Route 1']).toMatchObject({ status: 'alive', members: { ash: a, misty: b } });
    expect(s.mons[a].status).toBe('alive');
    expect(s.alerts.at(-1)).toMatchObject({ kind: 'link-formed' });
  });

  it('links starters into the Starter area', () => {
    const log = twoPlayer();
    log.starter('ash', 4);
    log.starter('misty', 7);
    const s = log.state();
    expect(s.links[`link:${STARTER_AREA}`].status).toBe('alive');
  });

  it('only the first encounter counts; a second catch is flagged', () => {
    const log = twoPlayer();
    log.catch('ash', 'Route 1', 16);
    log.catch('ash', 'Route 1', 19, 'second');
    const s = log.state();
    expect(s.mons.second.status).toBe('extra');
    expect(s.warnings.map((w) => w.code)).toContain('second-catch');
  });

  it('works for four players', () => {
    const log = new Log().join('a', 'b', 'c', 'd').settings();
    ['a', 'b', 'c'].forEach((p, i) => log.catch(p, 'Route 1', 10 + i));
    expect(log.state().links['link:Route 1'].status).toBe('pending');
    log.catch('d', 'Route 1', 20);
    expect(log.state().links['link:Route 1'].status).toBe('alive');
  });
});

describe('deaths', () => {
  it('kills every partner and alerts only the players who must box', () => {
    const log = new Log().join('a', 'b', 'c').settings();
    const ua = log.catch('a', 'Route 1', 16);
    const ub = log.catch('b', 'Route 1', 19);
    const uc = log.catch('c', 'Route 1', 21);
    log.faint('a', ua, 16, { kind: 'trainer', trainerId: 5, trainerName: 'Bug Catcher Rick', enemySpecies: 10, enemyLevel: 6 });
    const s = log.state();
    expect(s.mons[ua]).toMatchObject({ status: 'dead', death: { cause: { trainerName: 'Bug Catcher Rick' } } });
    expect(s.mons[ub].status).toBe('link-dead');
    expect(s.mons[uc].status).toBe('link-dead');
    expect(s.links['link:Route 1'].status).toBe('dead');
    const deaths = s.alerts.filter((x) => x.kind === 'link-death');
    expect(deaths.map((d) => d.players)).toEqual([['b'], ['c']]);
    expect(s.feed.find((f) => f.kind === 'death')?.text).toMatch(/Bug Catcher Rick \(Lv6\)/);
  });

  it('a partner caught after the death is dead on arrival', () => {
    const log = twoPlayer();
    const ua = log.catch('ash', 'Route 1', 16);
    log.faint('ash', ua);
    const ub = log.catch('misty', 'Route 1', 19);
    const s = log.state();
    expect(s.mons[ub].status).toBe('link-dead');
    expect(s.alerts.at(-1)).toMatchObject({ kind: 'link-death', players: ['misty'] });
  });

  it('ignores faints before the first wild encounter when grace is on', () => {
    const log = twoPlayer();
    const s1 = log.starter('ash', 4);
    log.starter('misty', 7);
    log.faint('ash', s1, 4);
    expect(log.state().mons[s1].status).toBe('alive');
    const strict = twoPlayer({ graceUntilFirstEncounter: false });
    const s2 = strict.starter('ash', 4);
    strict.starter('misty', 7);
    strict.faint('ash', s2, 4);
    expect(strict.state().mons[s2].status).toBe('dead');
  });

  it('does not double-count a second faint report', () => {
    const log = twoPlayer();
    const ua = log.catch('ash', 'Route 1', 16);
    log.catch('misty', 'Route 1', 19);
    log.faint('ash', ua);
    log.faint('ash', ua);
    expect(log.state().feed.filter((f) => f.kind === 'death')).toHaveLength(1);
  });
});

describe('failed encounters', () => {
  it('classic: the partner catch becomes unusable', () => {
    const log = twoPlayer({ failedEncounter: 'classic' });
    const ua = log.catch('ash', 'Route 1', 16);
    log.fail('misty', 'Route 1', 19);
    const s = log.state();
    expect(s.mons[ua].status).toBe('link-failed');
    expect(s.links['link:Route 1'].status).toBe('failed');
    expect(s.alerts.at(-1)).toMatchObject({ kind: 'link-failed', players: ['ash'] });
  });

  it('retry token: lets the failing player re-roll the area, limited per run', () => {
    const log = twoPlayer({ failedEncounter: 'retry-token', retryTokens: 1 });
    const ua = log.catch('ash', 'Route 1', 16);
    log.fail('misty', 'Route 1', 19);
    log.act('misty', { type: 'use-retry', area: 'Route 1' });
    let s = log.state();
    expect(s.players.misty.retryUsed).toBe(1);
    expect(s.mons[ua].status).toBe('pending');
    const ub = log.catch('misty', 'Route 1', 21);
    s = log.state();
    expect(s.links['link:Route 1'].status).toBe('alive');
    expect(s.mons[ub].status).toBe('alive');
    // Out of tokens: a second retry does nothing.
    log.catch('ash', 'Route 2', 10);
    log.fail('misty', 'Route 2', 13);
    log.act('misty', { type: 'use-retry', area: 'Route 2' });
    s = log.state();
    expect(s.players.misty.retryUsed).toBe(1);
    expect(s.links['link:Route 2'].status).toBe('failed');
  });

  it('orphan: boxed partners are adopted into a new link later', () => {
    const log = twoPlayer({ failedEncounter: 'orphan' });
    const ua = log.catch('ash', 'Route 1', 16);
    log.fail('misty', 'Route 1', 19);
    expect(log.state().mons[ua].status).toBe('orphan');
    log.fail('ash', 'Route 2', 10);
    const ub = log.catch('misty', 'Route 2', 13);
    const s = log.state();
    expect(s.mons[ua].status).toBe('alive');
    expect(s.mons[ub].status).toBe('alive');
    const orphanLink = Object.values(s.links).find((l) => l.id.startsWith('orphan-'))!;
    expect(orphanLink).toMatchObject({ status: 'alive', members: { ash: ua, misty: ub }, area: 'Route 1 + Route 2' });
    // And deaths propagate through the adopted link.
    log.faint('ash', ua);
    expect(log.state().mons[ub].status).toBe('link-dead');
  });

  it('everyone failing just leaves the area empty', () => {
    const log = twoPlayer();
    log.fail('ash', 'Route 1', 16);
    log.fail('misty', 'Route 1', 19);
    expect(log.state().links['link:Route 1'].status).toBe('failed');
  });
});

describe('clauses', () => {
  it('dupes clause warns before the catch and lets the next encounter count', () => {
    const log = twoPlayer({ dupesClause: true });
    log.catch('ash', 'Route 1', 16); // Pidgey
    log.ev('ash', { type: 'encounter', place: P('Route 2'), species: 17, level: 9 }); // Pidgeotto: same family
    let s = log.state();
    expect(s.warnings.at(-1)).toMatchObject({ code: 'dupe', preCatch: true });
    expect(s.players.ash.encounters['Route 2']).toBeUndefined();
    log.ev('ash', { type: 'encounter-end', place: P('Route 2'), species: 17, level: 9, result: 'ran' });
    const u = log.catch('ash', 'Route 2', 21);
    s = log.state();
    expect(s.players.ash.encounters['Route 2']).toMatchObject({ species: 21, uid: u });
  });

  it('dupes scope "run" counts partners’ catches too', () => {
    const log = twoPlayer({ dupesClause: true, dupesScope: 'run' });
    log.catch('misty', 'Route 1', 16);
    log.ev('ash', { type: 'encounter', place: P('Route 2'), species: 16, level: 3 });
    expect(log.state().warnings.at(-1)?.code).toBe('dupe');
    const own = twoPlayer({ dupesClause: true, dupesScope: 'player' });
    own.catch('misty', 'Route 1', 16);
    own.ev('ash', { type: 'encounter', place: P('Route 2'), species: 16, level: 3 });
    expect(own.state().warnings).toHaveLength(0);
  });

  it('dupes follow evolutions', () => {
    const log = twoPlayer({ dupesClause: true });
    const u = log.catch('ash', 'Route 1', 4);
    log.ev('ash', { type: 'evolved', mon: { uid: u, species: 5, nickname: '', level: 16 }, fromSpecies: 4 });
    log.ev('ash', { type: 'encounter', place: P('Route 3'), species: 6, level: 30 });
    expect(log.state().warnings.at(-1)?.code).toBe('dupe');
  });

  it('shiny clause: shinies never use the encounter', () => {
    const log = twoPlayer({ shinyClause: true });
    log.ev('ash', { type: 'encounter', place: P('Route 1'), species: 16, level: 3, shiny: true });
    const s = log.state();
    expect(s.warnings.at(-1)).toMatchObject({ code: 'shiny', preCatch: true });
    expect(s.players.ash.encounters['Route 1']).toBeUndefined();
  });

  it('type clause warns before a catch that would clash with a living link', () => {
    const log = twoPlayer({ typeClause: true });
    log.catch('ash', 'Route 1', 4); // Charmander: fire
    log.catch('misty', 'Route 1', 7);
    log.ev('ash', { type: 'encounter', place: P('Route 2'), species: 58, level: 10 }); // Growlithe: fire
    expect(log.state().warnings.at(-1)).toMatchObject({ code: 'type-clause', preCatch: true });
  });

  it('type clause uses the game generation and hack retypes', () => {
    // Clefairy is normal in Gen 3, fairy from Gen 6.
    const gen3 = twoPlayer({ typeClause: true });
    gen3.push({ kind: 'settings', settings: { ...PRESETS.classic, typeClause: true }, game: { generation: 3 } });
    gen3.catch('ash', 'Route 1', 16); // Pidgey normal
    gen3.catch('misty', 'Route 1', 19);
    gen3.ev('ash', { type: 'encounter', place: P('Mt Moon'), species: 35, level: 10 });
    expect(gen3.state().warnings.at(-1)?.code).toBe('type-clause');

    const hack = twoPlayer({ typeClause: true });
    hack.push({ kind: 'settings', settings: { ...PRESETS.classic, typeClause: true }, game: { generation: 4, typeOverrides: { '35': ['fairy'] } } });
    hack.catch('ash', 'Route 1', 16);
    hack.catch('misty', 'Route 1', 19);
    hack.ev('ash', { type: 'encounter', place: P('Mt Moon'), species: 35, level: 10 });
    expect(hack.state().warnings.filter((w) => w.code === 'type-clause')).toHaveLength(0);
  });

  it('gifts: count as encounters only when enabled (starter always counts)', () => {
    const on = twoPlayer({ giftsAreEncounters: true });
    on.starter('ash', 4);
    on.ev('ash', { type: 'obtained', place: P('Celadon City'), mon: mon('eevee', 133), method: 'gift' });
    expect(on.state().mons.eevee.status).toBe('pending');
    const off = twoPlayer({ giftsAreEncounters: false });
    off.starter('ash', 4);
    off.ev('ash', { type: 'obtained', place: P('Celadon City'), mon: mon('eevee', 133), method: 'gift' });
    const s = off.state();
    expect(s.mons.eevee.status).toBe('extra');
    expect(s.mons['ash-starter'].status).toBe('pending');
  });
});

describe('party legality', () => {
  function linked() {
    const log = twoPlayer({ typeClause: true });
    const a1 = log.catch('ash', 'Route 1', 4);
    const m1 = log.catch('misty', 'Route 1', 7);
    const a2 = log.catch('ash', 'Route 2', 58);
    const m2 = log.catch('misty', 'Route 2', 60);
    return { log, a1, m1, a2, m2 };
  }

  it('warns about using a dead Pokémon', () => {
    const { log, a1, m1 } = linked();
    log.faint('ash', a1, 4);
    log.party('ash', [{ uid: a1, species: 4 }]);
    log.party('misty', [{ uid: m1, species: 7 }]);
    const codes = log.state().warnings.map((w) => `${w.playerId}:${w.code}`);
    expect(codes).toContain('ash:dead-in-party');
    expect(codes).toContain('misty:unusable-in-party');
  });

  it('warns when a partner is boxed', () => {
    const { log, a1, m1, m2 } = linked();
    log.party('misty', [{ uid: m2, species: 60 }]);
    log.party('ash', [{ uid: a1, species: 4 }]);
    const w = log.state().warnings.filter((x) => x.code === 'partner-not-in-party');
    expect(w.map((x) => x.playerId)).toEqual(['ash', 'misty']);
  });

  it('flags type clause clashes on the combined team', () => {
    const { log, a1, m1, a2, m2 } = linked(); // Charmander/Squirtle and Growlithe/Poliwag: two fire links
    log.party('ash', [{ uid: a1, species: 4 }, { uid: a2, species: 58 }]);
    log.party('misty', [{ uid: m1, species: 7 }, { uid: m2, species: 60 }]);
    expect(log.state().warnings.some((w) => w.code === 'type-clause' && !w.preCatch)).toBe(true);
  });

  it('does not repeat the same warning on every party update', () => {
    const { log, a1 } = linked();
    log.faint('ash', a1, 4);
    log.party('ash', [{ uid: a1, species: 4 }]);
    log.party('ash', [{ uid: a1, species: 4 }]);
    log.party('ash', [{ uid: a1, species: 4 }]);
    expect(log.state().warnings.filter((w) => w.code === 'dead-in-party')).toHaveLength(1);
  });

  it('level caps: displays the cap and warns when over it', () => {
    const log = new Log().join('ash', 'misty');
    log.push({ kind: 'settings', settings: { ...PRESETS.classic, levelCaps: true }, levelCaps: [{ badge: 1, label: 'Brock', level: 14 }, { badge: 2, label: 'Misty', level: 21 }] });
    const u = log.catch('ash', 'Route 1', 16);
    log.catch('misty', 'Route 1', 19);
    expect(currentLevelCap(log.state(), 'ash')).toBe(14);
    log.party('ash', [{ uid: u, species: 16, level: 15 }]);
    expect(log.state().warnings.at(-1)?.code).toBe('over-level-cap');
    log.ev('ash', { type: 'badge', index: 0, count: 1 });
    expect(currentLevelCap(log.state(), 'ash')).toBe(21);
  });
});

describe('team sync helper', () => {
  it('lists usable links and avoids type clashes in the suggestion', () => {
    const log = twoPlayer({ typeClause: true });
    log.catch('ash', 'Route 1', 4, 'a1', 10);
    log.catch('misty', 'Route 1', 7, 'm1', 10);
    log.catch('ash', 'Route 2', 58, 'a2', 20); // fire again
    log.catch('misty', 'Route 2', 60, 'm2', 20); // water again
    log.catch('ash', 'Route 3', 25, 'a3', 5);
    log.catch('misty', 'Route 3', 43, 'm3', 5);
    const t = teamOptions(log.state());
    expect(t.usable).toHaveLength(3);
    expect(t.typeConflicts).toEqual([['link:Route 1', 'link:Route 2']]);
    expect(t.suggested).toEqual(['link:Route 2', 'link:Route 3']);
  });
});

describe('pacing gates and revive shards', () => {
  it('shows who is waiting at a gate and opens it when everyone catches up', () => {
    const log = twoPlayer({ pacingGates: [1, 2] });
    log.ev('ash', { type: 'badge', index: 0, count: 1 });
    expect(pacing(log.state())).toEqual({ gate: 1, waiting: ['ash'], behind: ['misty'] });
    log.ev('misty', { type: 'badge', index: 0, count: 1 });
    expect(log.state().alerts.at(-1)?.kind).toBe('gate-open');
    expect(pacing(log.state())).toEqual({ gate: 2, waiting: [], behind: [] });
  });

  it('earns shards from team badge progress and spends one to revive a link', () => {
    const log = twoPlayer({ reviveShards: { enabled: true, perBadge: 1, max: 2 } });
    const a = log.catch('ash', 'Route 1', 16);
    const m = log.catch('misty', 'Route 1', 19);
    log.faint('ash', a);
    log.act('ash', { type: 'use-revive', linkId: 'link:Route 1' });
    expect(log.state().mons[a].status).toBe('dead'); // no shards yet
    log.ev('ash', { type: 'badge', index: 0, count: 1 });
    expect(log.state().reviveShards.earned).toBe(0); // slowest player still at 0
    log.ev('misty', { type: 'badge', index: 0, count: 1 });
    expect(log.state().reviveShards.earned).toBe(1);
    log.act('ash', { type: 'use-revive', linkId: 'link:Route 1' });
    const s = log.state();
    expect(s.mons[a].status).toBe('alive');
    expect(s.mons[m].status).toBe('alive');
    expect(s.reviveShards).toEqual({ earned: 1, used: 1 });
  });
});

describe('wipes', () => {
  it('ends the run when configured', () => {
    const log = twoPlayer({ wipe: 'ends-run' });
    log.catch('ash', 'Route 1', 16);
    log.ev('ash', { type: 'whiteout', place: P('Route 2') });
    expect(log.state().status).toBe('failed');
  });

  it('or only kills the links in the wiped party', () => {
    const log = twoPlayer({ wipe: 'kills-active-links' });
    const a1 = log.catch('ash', 'Route 1', 16);
    const m1 = log.catch('misty', 'Route 1', 19);
    const a2 = log.catch('ash', 'Route 2', 10);
    log.catch('misty', 'Route 2', 13);
    log.party('ash', [{ uid: a1, species: 16 }]);
    log.ev('ash', { type: 'whiteout', place: P('Route 2') });
    const s = log.state();
    expect(s.status).toBe('active');
    expect(s.mons[a1].status).toBe('dead');
    expect(s.mons[m1].status).toBe('link-dead');
    expect(s.mons[a2].status).toBe('alive');
  });

  it('ignores the forced first-rival loss during grace', () => {
    const log = twoPlayer({ wipe: 'ends-run' });
    log.starter('ash', 4);
    log.ev('ash', { type: 'whiteout', place: P('Pallet Town') });
    expect(log.state().status).toBe('active');
  });
});

describe('undo, disputes and determinism', () => {
  it('undo voids an event and the state rebuilds without it; undoing the undo restores it', () => {
    const log = twoPlayer();
    const a = log.catch('ash', 'Route 1', 16);
    log.catch('misty', 'Route 1', 19);
    const faintSeq = log.ev('ash', { type: 'faint', place: P('Route 2'), mon: { uid: a, species: 16, nickname: '', level: 5 }, cause: { kind: 'other' } });
    expect(log.state().mons[a].status).toBe('dead');
    const undoSeq = log.push({ kind: 'undo', playerId: 'misty', target: faintSeq });
    let s = log.state();
    expect(s.mons[a].status).toBe('alive');
    expect(s.voided).toEqual([faintSeq]);
    log.push({ kind: 'undo', playerId: 'ash', target: undoSeq });
    s = log.state();
    expect(s.mons[a].status).toBe('dead');
  });

  it('rebuilding from the same log is deterministic, regardless of entry order', () => {
    const log = twoPlayer({ failedEncounter: 'orphan', reviveShards: { enabled: true, perBadge: 1, max: 3 } });
    log.catch('ash', 'Route 1', 16);
    log.fail('misty', 'Route 1', 19);
    log.fail('ash', 'Route 2', 10);
    log.catch('misty', 'Route 2', 13);
    log.ev('ash', { type: 'badge', index: 0, count: 1 });
    const a = buildRunState(log.entries);
    const b = buildRunState([...log.entries].reverse());
    expect(b).toEqual(a);
  });

  it('a majority-accepted dispute voids the disputed event', () => {
    const log = new Log().join('a', 'b', 'c').settings({ disputeQuorum: 'majority' });
    const ua = log.catch('a', 'Route 1', 16);
    log.catch('b', 'Route 1', 19);
    log.catch('c', 'Route 1', 21);
    const f = log.ev('a', { type: 'faint', place: P('Route 2'), mon: { uid: ua, species: 16, nickname: '', level: 5 }, cause: { kind: 'other' } });
    log.push({ kind: 'dispute-open', playerId: 'a', disputeId: 'd1', target: f, reason: 'misclick in a cutscene' });
    expect(log.state().disputes.d1.status).toBe('open');
    expect(log.state().mons[ua].status).toBe('dead');
    log.push({ kind: 'dispute-vote', playerId: 'b', disputeId: 'd1', approve: true });
    const s = log.state();
    expect(s.disputes.d1.status).toBe('accepted');
    expect(s.mons[ua].status).toBe('alive');
  });

  it('unanimous disputes fail on a single no', () => {
    const log = new Log().join('a', 'b', 'c').settings({ disputeQuorum: 'unanimous' });
    const ua = log.catch('a', 'Route 1', 16);
    const f = log.ev('a', { type: 'faint', place: P('Route 2'), mon: { uid: ua, species: 16, nickname: '', level: 5 }, cause: { kind: 'other' } });
    log.push({ kind: 'dispute-open', playerId: 'a', disputeId: 'd1', target: f, reason: 'lag' });
    log.push({ kind: 'dispute-vote', playerId: 'b', disputeId: 'd1', approve: true });
    log.push({ kind: 'dispute-vote', playerId: 'c', disputeId: 'd1', approve: false });
    const s = log.state();
    expect(s.disputes.d1.status).toBe('rejected');
    expect(s.mons[ua].status).toBe('dead');
  });
});

describe('manual mode', () => {
  it('supports a whole run with quick buttons only', () => {
    const log = twoPlayer();
    log.act('ash', { type: 'manual-encounter', area: 'Route 1', species: 16, nickname: 'Birb', result: 'caught' });
    log.act('misty', { type: 'manual-encounter', area: 'Route 1', species: 19, result: 'caught' });
    log.act('ash', { type: 'manual-encounter', area: 'Route 2', species: 10, result: 'failed' });
    log.act('misty', { type: 'manual-encounter', area: 'Route 2', species: 13, result: 'caught' });
    let s = log.state();
    const ashMon = Object.values(s.mons).find((m) => m.owner === 'ash')!;
    expect(ashMon).toMatchObject({ nickname: 'Birb', status: 'alive', origin: 'manual' });
    expect(s.links['link:Route 2'].status).toBe('failed');
    log.act('ash', { type: 'manual-death', uid: ashMon.uid });
    log.act('ash', { type: 'manual-badge', count: 1 });
    s = log.state();
    expect(s.mons[ashMon.uid].status).toBe('dead');
    expect(Object.values(s.mons).find((m) => m.owner === 'misty' && m.area === 'Route 1')?.status).toBe('link-dead');
    expect(s.players.ash.badges).toBe(1);
  });

  it('can finish a run', () => {
    const log = twoPlayer();
    log.act('ash', { type: 'finish-run', result: 'won' });
    expect(log.state().status).toBe('won');
  });
});

import { runStats } from './stats';

describe('run stats', () => {
  it('derives graveyard, MVP and closest calls from the log', () => {
    const log = twoPlayer();
    const a = log.catch('ash', 'Route 1', 16);
    const m = log.catch('misty', 'Route 1', 19);
    const a2 = log.catch('ash', 'Route 2', 25);
    log.catch('misty', 'Route 2', 43);
    log.party('ash', [{ uid: a2, species: 25 }]);
    log.ev('ash', { type: 'trainer-battle', place: P('Pewter City'), trainerId: 1, trainerName: 'Leader Brock', result: 'won' });
    log.ev('ash', { type: 'close-call', place: P('Pewter City'), mon: { uid: a2, species: 25, nickname: '', level: 12 }, hp: 1, maxHp: 30, cause: { kind: 'trainer' } });
    log.faint('ash', a, 16, { kind: 'trainer', trainerName: 'Bug Catcher', enemySpecies: 13, enemyLevel: 9 });
    const st = runStats(log.entries);
    expect(st.perPlayer.ash).toMatchObject({ catches: 2, deaths: 1, trainerWins: 1 });
    expect(st.graveyard.map((g) => [g.uid, g.linkDeath])).toEqual([[a, false], [m, true]]);
    expect(st.mvp).toMatchObject({ uid: a2, wins: 1 });
    expect(st.closestCalls[0]).toMatchObject({ uid: a2, hp: 1 });
    expect(st.links).toEqual({ total: 2, alive: 1, dead: 1, failed: 0 });
  });
});
