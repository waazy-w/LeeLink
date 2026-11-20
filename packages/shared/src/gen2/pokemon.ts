/**
 * Gen 2 (Gold/Silver/Crystal) Pokémon structure decoding. Multi-byte fields are big-endian.
 *
 * party_struct (48 bytes; box_struct is the first 32):
 *   0x00 species (national dex)  0x01 item  0x02 moves[4]  0x06 ot id u16  0x08 exp u24
 *   0x0B stat exp u16[5]  0x15 dvs u16  0x17 pp[4]  0x1B happiness (egg cycles for eggs)
 *   0x1C pokerus  0x1D caught data u16 (Crystal: time/level, gender/location)  0x1F level
 *   | 0x20 status  0x21 unused  0x22 hp u16  0x24 max hp u16  0x26 stats u16[5]
 * battle_struct (32 bytes, wEnemyMon):
 *   0x00 species  0x01 item  0x02 moves[4]  0x06 dvs u16  0x08 pp[4]  0x0C happiness  0x0D level
 *   0x0E status[2]  0x10 hp u16  0x12 max hp u16  0x14 stats u16[5]  0x1E types[2]
 *
 * Eggs are marked in the species list (EGG = 0xFD); the struct keeps the real species.
 */
import type { PokemonData } from '../model';
import { be16, be24, decodeGbStatus, gbUid } from '../gen1/gb';
import type { GbDecodeResult, GbPokemonSpec } from '../gen1/pokemon';
import { decodeGen2String, encodeGen2String } from './charset';

export const GEN2_PARTY_MON_SIZE = 48;
export const GEN2_BOX_MON_SIZE = 32;
export const GEN2_BATTLE_MON_SIZE = 32;
export const GEN2_EGG = 0xfd;
export const GEN2_MAX_SPECIES = 251;

export interface Gen2DecodeInput {
  raw: Uint8Array;
  /** Species list entry for this slot (0xFD for eggs); must agree with the struct otherwise. */
  listSpecies?: number;
  nickname?: Uint8Array;
  /** Crystal stores met level/location in bytes 0x1D-0x1E; Gold/Silver leave them unused. */
  caughtData?: boolean;
  maxSpecies?: number;
}

export function decodeGen2Pokemon({ raw, listSpecies, nickname, caughtData = false, maxSpecies = GEN2_MAX_SPECIES }: Gen2DecodeInput): GbDecodeResult {
  const species = raw[0];
  if (species === 0) return { ok: false, reason: 'empty' };
  const isEgg = listSpecies === GEN2_EGG;
  if (listSpecies !== undefined && !isEgg && listSpecies !== species) return { ok: false, reason: 'mismatch' };
  if (species > maxSpecies) return { ok: false, reason: 'unknown-species' };

  const isParty = raw.length >= GEN2_PARTY_MON_SIZE;
  const level = raw[0x1f];
  const hp = isParty ? be16(raw, 0x22) : undefined;
  const maxHp = isParty ? be16(raw, 0x24) : undefined;
  if (level < 1 || level > 100) return { ok: false, reason: 'invalid' };
  if (isParty && !isEgg && (maxHp === 0 || hp! > maxHp!)) return { ok: false, reason: 'invalid' };

  const otId = be16(raw, 0x06);
  const dvs = be16(raw, 0x15);
  const caught = caughtData ? be16(raw, 0x1d) : 0;
  const mon: PokemonData = {
    uid: gbUid(2, otId, dvs, caught),
    species,
    nickname: nickname ? decodeGen2String(nickname) : '',
    level,
    hp,
    maxHp,
    status: isParty ? decodeGbStatus(raw[0x20]) : 'ok',
    isEgg,
    otId,
    heldItem: raw[0x01],
    moves: [...raw.subarray(0x02, 0x06)].filter(Boolean),
    experience: be24(raw, 0x08),
  };
  if (caughtData && caught) {
    mon.metLevel = raw[0x1d] & 0x3f;
    mon.metLocation = raw[0x1e] & 0x7f;
  }
  return { ok: true, mon };
}

export function decodeGen2BattleMon(raw: Uint8Array, maxSpecies = GEN2_MAX_SPECIES): GbDecodeResult {
  const species = raw[0];
  if (species === 0) return { ok: false, reason: 'empty' };
  if (species > maxSpecies) return { ok: false, reason: 'unknown-species' };
  const level = raw[0x0d];
  const hp = be16(raw, 0x10);
  const maxHp = be16(raw, 0x12);
  if (level < 1 || level > 100 || maxHp === 0 || hp > maxHp) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    mon: {
      uid: gbUid(2, 0, be16(raw, 0x06)),
      species,
      nickname: '',
      level,
      hp,
      maxHp,
      status: decodeGbStatus(raw[0x0e]),
      isEgg: false,
      otId: 0,
      heldItem: raw[0x01],
      moves: [...raw.subarray(0x02, 0x06)].filter(Boolean),
      experience: 0,
    },
  };
}

export const gen2Dvs = (raw: Uint8Array, battle = false) => be16(raw, battle ? 0x06 : 0x15);

const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };

export interface Gen2PokemonSpec extends GbPokemonSpec {
  heldItem?: number;
  caughtData?: number;
}

/** Builds a 48-byte Gen 2 party struct. Used by tests and synthetic fixtures. */
export function encodeGen2Pokemon(spec: Gen2PokemonSpec): Uint8Array {
  const out = new Uint8Array(GEN2_PARTY_MON_SIZE);
  out[0] = spec.species;
  out[0x01] = spec.heldItem ?? 0;
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => (out[0x02 + i] = m));
  put16(out, 0x06, spec.otId);
  const exp = spec.exp ?? spec.level ** 3;
  out[0x08] = (exp >> 16) & 0xff; out[0x09] = (exp >> 8) & 0xff; out[0x0a] = exp & 0xff;
  put16(out, 0x15, spec.dvs);
  put16(out, 0x1d, spec.caughtData ?? 0);
  out[0x1f] = spec.level;
  out[0x20] = spec.status ?? 0;
  put16(out, 0x22, spec.hp);
  put16(out, 0x24, spec.maxHp);
  return out;
}

/** Builds a 32-byte Gen 2 battle struct (wEnemyMon). */
export function encodeGen2BattleMon(spec: Gen2PokemonSpec): Uint8Array {
  const out = new Uint8Array(GEN2_BATTLE_MON_SIZE);
  out[0] = spec.species;
  out[0x01] = spec.heldItem ?? 0;
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => (out[0x02 + i] = m));
  put16(out, 0x06, spec.dvs);
  out[0x0d] = spec.level;
  out[0x0e] = spec.status ?? 0;
  put16(out, 0x10, spec.hp);
  put16(out, 0x12, spec.maxHp);
  return out;
}

export const encodeGen2Name = (name: string) => encodeGen2String(name, 11);
