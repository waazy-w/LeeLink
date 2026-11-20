import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeSnapshot, snapshotReader } from '../memory/reader';
import { ProfileRegistry } from '../profiles/registry';
import { createProfileReader } from '../profiles/engines';
import { EventDetector } from '../tracking/detector';

const dir = new URL('../../fixtures/red/', import.meta.url);
const red = new ProfileRegistry().resolve('red-us-rev0')!;
const load = (f: string) => createProfileReader(red, snapshotReader(decodeSnapshot(new Uint8Array(gunzipSync(readFileSync(new URL(f, dir)))))))!.read();

describe('Pokémon Red on recorded memory', () => {
  it('reads the starter, battles and locations', () => {
    expect(load('00-intro.llsnap.gz').inGame).toBe(false);
    const s = load('01-starter.llsnap.gz');
    expect(s.location.name).toBe("Oak's Lab");
    expect(s.party[0].mon).toMatchObject({ species: 7, level: 5, hp: 19 });
    expect(load('02-rival-battle.llsnap.gz').battle).toMatchObject({ active: true, kind: 'trainer' });
    expect(load('07-wild-encounter.llsnap.gz').battle.enemy[0].species).toBe(16);
  });

  it('turns the recorded sequence into events', () => {
    const d = new EventDetector(red);
    const events = readdirSync(dir).sort().flatMap((f) => {
      const s = load(f);
      return [...d.push(s), ...d.push(s)]; // two samples per fixture (faint confirmation)
    });
    expect(events.map((e) => e.type)).toEqual([
      'session', 'faint', 'whiteout', 'trainer-battle', 'location', 'revived', 'encounter', 'encounter-end', 'encounter', 'encounter-end',
    ]);
    expect(events.filter((e) => e.type === 'encounter-end').map((e) => 'result' in e && e.result)).toEqual(['ran', 'won']);
    expect(events.find((e) => e.type === 'faint')).toMatchObject({ mon: { species: 7 }, cause: { kind: 'trainer', enemySpecies: 1 } });
  });
});
