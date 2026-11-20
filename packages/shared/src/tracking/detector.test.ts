import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeSnapshot, snapshotReader } from '../memory/reader';
import { ProfileRegistry } from '../profiles/registry';
import { createProfileReader } from '../profiles/engines';
import type { GameState } from '../profiles/types';
import type { PokemonData } from '../model';
import { EventDetector } from './detector';

const registry = new ProfileRegistry();
const firered = registry.resolve('firered-bpre-rev0')!;

function load(name: string): GameState {
  const buf = gunzipSync(readFileSync(new URL(`../../fixtures/firered/${name}.llsnap.gz`, import.meta.url)));
  const snap = decodeSnapshot(new Uint8Array(buf));
  return createProfileReader(firered, snapshotReader(snap))!.read({ boxes: true });
}

describe('FireRed reader on recorded memory', () => {
  it('reads the starter, trainer and location', () => {
    const s = load('01-starter');
    expect(s.inGame).toBe(true);
    expect(s.trainer?.name).toBe('AAA');
    expect(s.location.name).toBe('Pallet Town');
    expect(s.party).toHaveLength(1);
    expect(s.party[0].mon).toMatchObject({ species: 4, nickname: 'CHARMANDER', level: 5, hp: 19, maxHp: 19 });
    expect(s.badges).toEqual([false, false, false, false, false, false, false, false]);
  });

  it('reads a trainer battle', () => {
    const s = load('02-rival-battle');
    expect(s.battle).toMatchObject({ active: true, kind: 'trainer', trainerId: 326, activeSlots: [0] });
    expect(s.battle.enemy.map((e) => [e.species, e.level])).toEqual([[7, 5]]);
    expect(firered.trainers?.['326']?.name).toMatch(/Green|Rival/i);
  });

  it('reads a wild battle and its flee outcome', () => {
    const w = load('07-wild-encounter');
    expect(w.location.name).toBe('Route 1');
    expect(w.battle).toMatchObject({ active: true, kind: 'wild' });
    expect(w.battle.enemy[0]).toMatchObject({ species: 19, level: 3 });
    expect(load('08-fled').battle.result).toBe('ran');
  });
});

describe('EventDetector on a recorded FireRed sequence', () => {
  it('produces the expected events', () => {
    const d = new EventDetector(firered);
    const seq: [string, number][] = [
      ['01-starter', 1], ['02-rival-battle', 1], ['03-before-faint', 1], ['04-fainted', 2],
      ['05-after-rival', 1], ['06-route1', 1], ['07-wild-encounter', 1], ['08-fled', 1], ['09-after-flee', 1],
    ];
    const events = seq.flatMap(([name, times]) => {
      const s = load(name);
      return Array.from({ length: times }, () => d.push(s)).flat();
    });
    expect(events.map((e) => e.type)).toEqual([
      'session', 'faint', 'whiteout', 'trainer-battle', 'revived', 'location', 'encounter', 'encounter-end',
    ]);
    const faint = events.find((e) => e.type === 'faint')!;
    expect(faint).toMatchObject({
      mon: { species: 4, level: 5 },
      place: { name: 'Pallet Town' },
      cause: { kind: 'trainer', trainerId: 326, enemySpecies: 7, enemyLevel: 5 },
    });
    expect(events.find((e) => e.type === 'trainer-battle')).toMatchObject({ trainerId: 326, result: 'lost' });
    expect(events.find((e) => e.type === 'location')).toMatchObject({ place: { name: 'Route 1' }, from: { name: 'Pallet Town' } });
    expect(events.find((e) => e.type === 'encounter')).toMatchObject({ species: 19, level: 3, place: { area: 'Route 1' } });
    expect(events.find((e) => e.type === 'encounter-end')).toMatchObject({ species: 19, result: 'ran' });
  });

  it('does not report a faint from a single (possibly torn) sample', () => {
    const d = new EventDetector(firered);
    d.push(load('03-before-faint'));
    expect(d.push(load('04-fainted'))).toEqual([]);
    // A one-Pokémon party fainting is also a whiteout; the rules engine decides what that means.
    expect(d.push(load('04-fainted')).map((e) => e.type)).toEqual(['faint', 'whiteout']);
  });
});

// ---- synthetic sequences for paths that need items we don't have in the fixtures (balls, badges)

const mon = (uid: string, species: number, hp = 20, level = 5): PokemonData => ({
  uid, species, nickname: `M${species}`, level, hp, maxHp: 20, status: 'ok', isEgg: false, otId: 1, heldItem: 0, moves: [], experience: 0,
});

function state(p: Partial<GameState> & { partyMons?: PokemonData[] }): GameState {
  return {
    inGame: true,
    frame: 0,
    trainer: { name: 'T', id: 1 },
    party: (p.partyMons ?? []).map((m, slot) => ({ slot, mon: m })),
    location: { id: 101, name: 'Route 1', area: 'Route 1' },
    badges: Array(8).fill(false),
    battle: { active: false, kind: 'none', enemy: [], outcome: 0, result: 'none', activeSlots: [], flags: 0 },
    ...p,
  };
}

describe('EventDetector synthetic paths', () => {
  const starter = mon('a', 4);
  const wildBattle = (result: GameState['battle']['result'], active: boolean) => ({
    active, kind: 'wild' as const, enemy: [mon('w', 16, 15, 3)], outcome: 0, result, activeSlots: [0], flags: 4,
    enemyActive: [{ species: 16, level: 3 }],
  });

  it('attributes a new party member after a caught battle to that encounter', () => {
    const d = new EventDetector(firered);
    d.push(state({ partyMons: [starter] }));
    d.push(state({ partyMons: [starter], battle: wildBattle('none', true) }));
    const ev = d.push(state({ partyMons: [starter, mon('w', 16, 15, 3)], battle: wildBattle('caught', false) }));
    expect(ev.map((e) => e.type)).toEqual(['encounter-end', 'obtained']);
    expect(ev[1]).toMatchObject({ method: 'caught', place: { area: 'Route 1' }, mon: { species: 16 } });
  });

  it('treats Pokémon that appear outside battle as gifts', () => {
    const d = new EventDetector(firered);
    d.push(state({ partyMons: [starter] }));
    const ev = d.push(state({ partyMons: [starter, mon('g', 133)] }));
    expect(ev).toMatchObject([{ type: 'obtained', method: 'gift', mon: { species: 133 } }]);
  });

  it('notices catches that went straight to the PC', () => {
    const d = new EventDetector(firered);
    d.push(state({ partyMons: [starter], boxes: [] }));
    d.push(state({ partyMons: [starter], battle: wildBattle('none', true) }));
    d.push(state({ partyMons: [starter], battle: wildBattle('caught', false) }));
    const ev = d.push(state({ partyMons: [starter], boxes: [{ box: 0, slot: 0, mon: mon('w', 16, 15, 3) }] }));
    expect(ev).toMatchObject([{ type: 'obtained', method: 'caught' }]);
  });

  it('reports badges, evolutions and whiteouts', () => {
    const d = new EventDetector(firered);
    d.push(state({ partyMons: [starter] }));
    const badges = Array(8).fill(false);
    badges[0] = true;
    expect(d.push(state({ partyMons: [starter], badges }))).toMatchObject([{ type: 'badge', index: 0, count: 1 }]);
    expect(d.push(state({ partyMons: [{ ...starter, species: 5 }], badges }))).toMatchObject([{ type: 'evolved', fromSpecies: 4, mon: { species: 5 } }]);
    const down = { ...starter, species: 5, hp: 0 };
    d.push(state({ partyMons: [down], badges }));
    expect(d.push(state({ partyMons: [down], badges })).map((e) => e.type)).toEqual(['faint', 'whiteout']);
  });

  it('ignores slots that failed to decode instead of treating them as releases or faints', () => {
    const d = new EventDetector(firered);
    d.push(state({ partyMons: [starter] }));
    const torn = state({});
    torn.party = [{ slot: 0, error: 'checksum' }];
    expect(d.push(torn)).toEqual([]);
    expect(d.push(state({ partyMons: [starter] }))).toEqual([]);
  });

  it('ignores title screen samples', () => {
    const d = new EventDetector(firered);
    expect(d.push(state({ inGame: false }))).toEqual([]);
  });
});
