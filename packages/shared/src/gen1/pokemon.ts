/**
 * Gen 1 (Red/Blue/Yellow) Pokémon structure decoding. All multi-byte fields are big-endian.
 *
 * party_struct (44 bytes; box_struct is the first 33):
 *   0x00 species (internal index)  0x01 hp u16  0x03 box level  0x04 status  0x05 type1  0x06 type2
 *   0x07 catch rate  0x08 moves[4]  0x0C ot id u16  0x0E exp u24  0x11 stat exp u16[5]
 *   0x1B dvs u16  0x1D pp[4]  | 0x21 level  0x22 max hp u16  0x24 atk/def/spd/spc u16[4]
 * battle_struct (29 bytes, wEnemyMon / wBattleMon):
 *   0x00 species  0x01 hp u16  0x03 party pos  0x04 status  0x05 types[2]  0x07 catch rate
 *   0x08 moves[4]  0x0C dvs u16  0x0E level  0x0F max hp u16  0x11 stats u16[4]  0x19 pp[4]
 *
 * Nicknames and OT names live in separate 11-byte arrays next to the struct array.
 * There's no checksum, so plausibility checks (species list agrees with the struct, sane level/HP)
 * are what reject torn or uninitialised data.
 */
import type { PokemonData } from '../model';
import { be16, be24, decodeGbStatus, gbUid } from './gb';
import { decodeGen1String, encodeGen1String } from './charset';
import { GEN1_INTERNAL_TO_NATIONAL } from './species-index';

export const GEN1_PARTY_MON_SIZE = 44;
export const GEN1_BOX_MON_SIZE = 33;
export const GEN1_BATTLE_MON_SIZE = 29;
export const GB_NAME_LENGTH = 11;

const NATIONAL_TO_INTERNAL = (() => {
  const m = new Map<number, number>();
  GEN1_INTERNAL_TO_NATIONAL.forEach((nat, idx) => nat && !m.has(nat) && m.set(nat, idx));
  return m;
})();

export const gen1ToNational = (internal: number) => GEN1_INTERNAL_TO_NATIONAL[internal] ?? 0;
export const gen1FromNational = (national: number) => NATIONAL_TO_INTERNAL.get(national) ?? 0;

export type GbDecodeResult =
  | { ok: true; mon: PokemonData }
  | { ok: false; reason: 'empty' | 'unknown-species' | 'mismatch' | 'invalid' };

export interface Gen1DecodeInput {
  raw: Uint8Array;
  /** Species list entry for this slot; must agree with the struct. */
  listSpecies?: number;
  nickname?: Uint8Array;
}

/** Decodes a party (44-byte) or box (33-byte) Gen 1 Pokémon. */
export function decodeGen1Pokemon({ raw, listSpecies, nickname }: Gen1DecodeInput): GbDecodeResult {
  const internal = raw[0];
  if (internal === 0) return { ok: false, reason: 'empty' };
  if (listSpecies !== undefined && listSpecies !== internal) return { ok: false, reason: 'mismatch' };
  const species = gen1ToNational(internal);
  if (!species) return { ok: false, reason: 'unknown-species' };

  const isParty = raw.length >= GEN1_PARTY_MON_SIZE;
  const level = isParty ? raw[0x21] : raw[0x03];
  const hp = be16(raw, 0x01);
  const maxHp = isParty ? be16(raw, 0x22) : undefined;
  if (level < 1 || level > 100) return { ok: false, reason: 'invalid' };
  if (maxHp !== undefined && (maxHp === 0 || hp > maxHp)) return { ok: false, reason: 'invalid' };

  const otId = be16(raw, 0x0c);
  const dvs = be16(raw, 0x1b);
  const mon: PokemonData = {
    uid: gbUid(1, otId, dvs),
    species,
    nickname: nickname ? decodeGen1String(nickname) : '',
    level,
    hp: isParty ? hp : undefined,
    maxHp,
    status: decodeGbStatus(raw[0x04]),
    isEgg: false,
    otId,
    heldItem: 0,
    moves: [...raw.subarray(0x08, 0x0c)].filter(Boolean),
    experience: be24(raw, 0x0e),
  };
  return { ok: true, mon };
}

/** Wild/active battler (battle_struct). No OT or experience; uid is derived from the DVs. */
export function decodeGen1BattleMon(raw: Uint8Array): GbDecodeResult {
  const internal = raw[0];
  if (internal === 0) return { ok: false, reason: 'empty' };
  const species = gen1ToNational(internal);
  if (!species) return { ok: false, reason: 'unknown-species' };
  const level = raw[0x0e];
  const hp = be16(raw, 0x01);
  const maxHp = be16(raw, 0x0f);
  if (level < 1 || level > 100 || maxHp === 0 || hp > maxHp) return { ok: false, reason: 'invalid' };
  const dvs = be16(raw, 0x0c);
  return {
    ok: true,
    mon: {
      uid: gbUid(1, 0, dvs),
      species,
      nickname: '',
      level,
      hp,
      maxHp,
      status: decodeGbStatus(raw[0x04]),
      isEgg: false,
      otId: 0,
      heldItem: 0,
      moves: [...raw.subarray(0x08, 0x0c)].filter(Boolean),
      experience: 0,
    },
  };
}

export const gen1Dvs = (raw: Uint8Array, battle = false) => be16(raw, battle ? 0x0c : 0x1b);

export interface GbPokemonSpec {
  species: number; // national
  level: number;
  hp: number;
  maxHp: number;
  otId: number;
  dvs: number;
  nickname?: string;
  status?: number;
  exp?: number;
  moves?: number[];
}

const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = (v >> 8) & 0xff; b[o + 1] = v & 0xff; };
const put24 = (b: Uint8Array, o: number, v: number) => { b[o] = (v >> 16) & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = v & 0xff; };

/** Builds a 44-byte Gen 1 party struct. Used by tests and synthetic fixtures. */
export function encodeGen1Pokemon(spec: GbPokemonSpec): Uint8Array {
  const out = new Uint8Array(GEN1_PARTY_MON_SIZE);
  out[0] = gen1FromNational(spec.species);
  put16(out, 0x01, spec.hp);
  out[0x03] = spec.level;
  out[0x04] = spec.status ?? 0;
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => (out[0x08 + i] = m));
  put16(out, 0x0c, spec.otId);
  put24(out, 0x0e, spec.exp ?? spec.level ** 3);
  put16(out, 0x1b, spec.dvs);
  out[0x21] = spec.level;
  put16(out, 0x22, spec.maxHp);
  return out;
}

/** Builds a 29-byte Gen 1 battle struct (wEnemyMon). */
export function encodeGen1BattleMon(spec: GbPokemonSpec, partyPos = 0): Uint8Array {
  const out = new Uint8Array(GEN1_BATTLE_MON_SIZE);
  out[0] = gen1FromNational(spec.species);
  put16(out, 0x01, spec.hp);
  out[0x03] = partyPos;
  out[0x04] = spec.status ?? 0;
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => (out[0x08 + i] = m));
  put16(out, 0x0c, spec.dvs);
  out[0x0e] = spec.level;
  put16(out, 0x0f, spec.maxHp);
  return out;
}

export const encodeGen1Name = (name: string) => encodeGen1String(name, GB_NAME_LENGTH);
