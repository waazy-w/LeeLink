import { describe, expect, it } from 'vitest';
import { decodeGen3Pokemon, encodeGen3Pokemon, VANILLA_GEN3_SPECIES } from './pokemon';
import { readGen3Party } from './party';
import { decodeGen3String, encodeGen3String } from './charset';
import { snapshotReader } from '../memory/reader';

const base = { otId: 0x1234abcd, nickname: 'SPARKY', level: 12, hp: 31, maxHp: 35 };

describe('gen3 charset', () => {
  it('round-trips names with symbols', () => {
    expect(decodeGen3String(encodeGen3String('Mr. MIME♂', 10))).toBe('Mr. MIME♂');
  });
});

describe('gen3 species index', () => {
  it('maps the Hoenn block to national numbers', () => {
    expect(VANILLA_GEN3_SPECIES.toNational(25)).toBe(25); // Pikachu: identical below 252
    expect(VANILLA_GEN3_SPECIES.toNational(277)).toBe(252); // Treecko
    expect(VANILLA_GEN3_SPECIES.toNational(411)).toBe(358); // Chimecho
    expect(VANILLA_GEN3_SPECIES.toNational(260)).toBe(0); // unused placeholder
  });
});

describe('decodeGen3Pokemon', () => {
  it('decodes every substructure order', () => {
    for (let p = 0; p < 24; p++) {
      const personality = 0x9a000000 + p; // % 24 cycles through all orders
      const raw = encodeGen3Pokemon({ ...base, personality, species: 252, moves: [1, 2, 3, 4], heldItem: 13, metLocation: 101, ball: 4 });
      const res = decodeGen3Pokemon(raw);
      expect(res.ok, `order ${personality % 24}`).toBe(true);
      if (!res.ok) continue;
      expect(res.mon).toMatchObject({
        species: 252, nickname: 'SPARKY', level: 12, hp: 31, maxHp: 35, moves: [1, 2, 3, 4],
        heldItem: 13, metLocation: 101, ball: 4, otId: base.otId, personality, isEgg: false, status: 'ok',
      });
    }
  });

  it('rejects a corrupted (mid-write) structure via checksum', () => {
    const raw = encodeGen3Pokemon({ ...base, personality: 7, species: 1 });
    raw[0x25] ^= 0xff;
    expect(decodeGen3Pokemon(raw)).toEqual({ ok: false, reason: 'checksum' });
  });

  it('treats zeroed memory as empty', () => {
    expect(decodeGen3Pokemon(new Uint8Array(100))).toEqual({ ok: false, reason: 'empty' });
  });

  it('decodes status conditions', () => {
    const cases: [number, string][] = [[0, 'ok'], [3, 'sleep'], [0x08, 'poison'], [0x88, 'toxic'], [0x10, 'burn'], [0x20, 'freeze'], [0x40, 'paralysis']];
    for (const [status, expected] of cases) {
      const res = decodeGen3Pokemon(encodeGen3Pokemon({ ...base, personality: 99, species: 4, status }));
      expect(res.ok && res.mon.status).toBe(expected);
    }
  });

  it('flags eggs', () => {
    const res = decodeGen3Pokemon(encodeGen3Pokemon({ ...base, personality: 5, species: 175, isEgg: true }));
    expect(res.ok && res.mon.isEgg).toBe(true);
  });

  it('derives level from experience for 80-byte box structures', () => {
    const raw = encodeGen3Pokemon({ ...base, personality: 11, species: 1, exp: 1059, level: 0 }).slice(0, 80);
    const res = decodeGen3Pokemon(raw);
    expect(res.ok && res.mon.level).toBe(12); // Bulbasaur: medium-slow, 1059 exp = Lv 12
    expect(res.ok && res.mon.hp).toBeUndefined();
  });
});

describe('readGen3Party', () => {
  it('reads count and slots from memory', () => {
    const ewram = new Uint8Array(0x40000);
    const PARTY = 0x02024284, COUNT = 0x02024029;
    ewram[COUNT - 0x02000000] = 2;
    ewram.set(encodeGen3Pokemon({ ...base, personality: 1, species: 4 }), PARTY - 0x02000000);
    const bad = encodeGen3Pokemon({ ...base, personality: 2, species: 7 });
    bad[0x30] ^= 1;
    ewram.set(bad, PARTY - 0x02000000 + 100);
    const mem = snapshotReader({ platform: 'gba', regions: [{ name: 'ewram', base: 0x02000000, data: ewram }] });
    const party = readGen3Party(mem, { party: PARTY, partyCount: COUNT });
    expect(party).toHaveLength(2);
    expect(party[0].mon?.species).toBe(4);
    expect(party[1]).toEqual({ slot: 1, error: 'checksum' });
  });
});
