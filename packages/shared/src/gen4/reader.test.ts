import { describe, expect, it } from 'vitest';
import { snapshotReader } from '../memory/reader';
import { ProfileRegistry } from '../profiles/registry';
import { createProfileReader } from '../profiles/engines';
import { EventDetector } from '../tracking/detector';
import { buildRunState } from '../engine/reducer';
import { PRESETS } from '../engine/settings';
import type { LogEntry } from '../engine/types';
import { encodeGen4Pokemon, GEN4_PARTY_MON_SIZE } from './pokemon';

const OT = 0x1234abcd;
const ram = new Uint8Array(0x400000);
const dv = new DataView(ram.buffer);
const mon = (personality: number, species: number, hp: number, otId = OT) =>
  encodeGen4Pokemon({ personality, otId, species, nickname: '', level: 5, hp, maxHp: 20 });

function writeParty(off: number, mons: Uint8Array[]) {
  dv.setUint32(off, 6, true);
  dv.setUint32(off + 4, mons.length, true);
  mons.forEach((m, i) => ram.set(m, off + 8 + i * GEN4_PARTY_MON_SIZE));
}
const clearParty = (off: number) => dv.setUint32(off, 0, true);

const PLAYER = 0x27e000;
const ENEMY = 0x2a0000;
const profile = new ProfileRegistry().resolve('renegade-platinum')!;
const reader = createProfileReader(profile, snapshotReader({ platform: 'nds', regions: [{ name: 'main', base: 0x02000000, data: ram }] }))!;

describe('Gen 4 DS reader (synthetic RAM)', () => {
  it('finds the party, sees a wild encounter, and infers the catch', () => {
    const det = new EventDetector(profile, { catchWindowSamples: 8 });
    const read = () => det.push(reader.read());
    const events = [];

    writeParty(PLAYER, [mon(0x1111, 393, 20)]); // Piplup starter
    for (let i = 0; i < 4; i++) events.push(...read());
    const s = reader.read();
    expect(s.inGame).toBe(true);
    expect(s.party[0].mon?.species).toBe(393);

    // Wild Starly (carries the player's OT id) appears in a second Party struct.
    writeParty(ENEMY, [mon(0x2222, 396, 15)]);
    for (let i = 0; i < 4; i++) events.push(...read());
    expect(reader.read().battle).toMatchObject({ active: true, kind: 'wild' });

    // Caught: the Starly (same personality) joins the party and the battle struct goes away.
    clearParty(ENEMY);
    writeParty(PLAYER, [mon(0x1111, 393, 20), mon(0x2222, 396, 15)]);
    for (let i = 0; i < 4; i++) events.push(...read());

    // Starter faints.
    writeParty(PLAYER, [mon(0x1111, 393, 0), mon(0x2222, 396, 15)]);
    for (let i = 0; i < 4; i++) events.push(...read());

    expect(events.map((e) => e.type)).toEqual(['encounter', 'encounter-end', 'obtained', 'faint']);
    expect(events.find((e) => e.type === 'encounter-end')).toMatchObject({ result: 'caught', species: 396 });
    expect(events.find((e) => e.type === 'obtained')).toMatchObject({ method: 'caught' });

    // The engine files the encounter under the player's manually set location.
    let seq = 0;
    const log: LogEntry[] = [
      { seq: ++seq, at: 0, kind: 'player-join', playerId: 'a', name: 'A' },
      { seq: ++seq, at: 0, kind: 'settings', settings: PRESETS.classic },
      { seq: ++seq, at: 0, kind: 'action', playerId: 'a', action: { type: 'manual-location', area: 'Route 201' } },
      ...events.map((event) => ({ seq: ++seq, at: 0, kind: 'tracker' as const, playerId: 'a', event })),
    ];
    const st = buildRunState(log);
    expect(st.players.a.encounters['Route 201']).toMatchObject({ species: 396, status: 'caught' });
  });

  it('treats a trainer’s Pokémon (different OT) as a trainer battle', () => {
    writeParty(PLAYER, [mon(0x1111, 393, 20)]);
    writeParty(ENEMY, [mon(0x3333, 399, 20, 0x99998888)]);
    const r = createProfileReader(profile, snapshotReader({ platform: 'nds', regions: [{ name: 'main', base: 0x02000000, data: ram }] }))!;
    for (let i = 0; i < 4; i++) r.read();
    expect(r.read().battle.kind).toBe('trainer');
    clearParty(ENEMY);
  });

  it('uses Fairy-era typings for Renegade Platinum', () => {
    expect(profile.typingGeneration).toBe(6);
    expect(profile.engine).toBe('gen4');
  });
});
