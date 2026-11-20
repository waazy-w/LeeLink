/**
 * Gen 3 (Ruby/Sapphire/Emerald/FireRed/LeafGreen) Pokémon structure decoding.
 *
 * Layout (struct Pokemon, 100 bytes; struct BoxPokemon is the first 80):
 *   0x00 personality u32   0x04 otId u32       0x08 nickname[10]   0x12 language
 *   0x13 flags (bit0 badEgg, bit1 hasSpecies, bit2 isEgg)          0x14 otName[7]
 *   0x1B markings          0x1C checksum u16   0x1E unknown u16
 *   0x20 secure[48]: four 12-byte substructs, order = personality % 24,
 *        each u32 XOR'd with (otId ^ personality)
 *   0x50 status u32  0x54 level  0x55 mail  0x56 hp  0x58 maxHp  0x5A..0x63 stats
 */
import type { MajorStatus, PokemonData } from '../model';
import { levelFromExp } from '../data/species';
import { decodeGen3String, encodeGen3String } from './charset';
import { GEN3_INTERNAL_TO_NATIONAL, GEN3_SPECIES_EGG } from './species-index';

export const GEN3_PARTY_MON_SIZE = 100;
export const GEN3_BOX_MON_SIZE = 80;

/** Substruct order permutations: letters are Growth, Attacks, EVs, Misc. */
const ORDERS = [
  'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
];

export interface Gen3SpeciesMap {
  /** Internal species index -> national dex number. Hacks with expanded species override this. */
  toNational(internal: number): number;
  fromNational(national: number): number;
}

export const VANILLA_GEN3_SPECIES: Gen3SpeciesMap = (() => {
  const reverse = new Map<number, number>();
  GEN3_INTERNAL_TO_NATIONAL.forEach((nat, idx) => nat && reverse.set(nat, idx));
  return {
    toNational: (i) => GEN3_INTERNAL_TO_NATIONAL[i] ?? 0,
    fromNational: (n) => reverse.get(n) ?? 0,
  };
})();

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function decodeStatus(raw: number): MajorStatus {
  if (raw & 0x7) return 'sleep';
  if (raw & 0x80) return 'toxic';
  if (raw & 0x08) return 'poison';
  if (raw & 0x10) return 'burn';
  if (raw & 0x20) return 'freeze';
  if (raw & 0x40) return 'paralysis';
  return 'ok';
}

export type Gen3DecodeResult =
  | { ok: true; mon: PokemonData }
  | { ok: false; reason: 'empty' | 'checksum' | 'bad-egg' | 'unknown-species' };

/** Decrypts the 48-byte secure section; returns substructs keyed G/A/E/M and the computed checksum. */
export function decryptSecure(raw: Uint8Array): { sub: Record<'G' | 'A' | 'E' | 'M', Uint8Array>; checksum: number } {
  const pid = u32(raw, 0);
  const key = (u32(raw, 4) ^ pid) >>> 0;
  const plain = new Uint8Array(48);
  let checksum = 0;
  for (let i = 0; i < 48; i += 4) {
    const v = (u32(raw, 0x20 + i) ^ key) >>> 0;
    plain[i] = v & 0xff; plain[i + 1] = (v >>> 8) & 0xff; plain[i + 2] = (v >>> 16) & 0xff; plain[i + 3] = v >>> 24;
    checksum = (checksum + (v & 0xffff) + (v >>> 16)) & 0xffff;
  }
  const order = ORDERS[pid % 24];
  const sub = {} as Record<'G' | 'A' | 'E' | 'M', Uint8Array>;
  for (let i = 0; i < 4; i++) sub[order[i] as 'G' | 'A' | 'E' | 'M'] = plain.subarray(i * 12, i * 12 + 12);
  return { sub, checksum };
}

/**
 * Decodes a party (100-byte) or box (80-byte) Pokémon.
 * Reads can catch the game mid-write, so a checksum failure is reported, never guessed around.
 */
export function decodeGen3Pokemon(raw: Uint8Array, speciesMap: Gen3SpeciesMap = VANILLA_GEN3_SPECIES): Gen3DecodeResult {
  const pid = u32(raw, 0);
  const otId = u32(raw, 4);
  const flags = raw[0x13];
  if (pid === 0 && otId === 0 && !(flags & 0x2)) return { ok: false, reason: 'empty' };
  if (flags & 0x1) return { ok: false, reason: 'bad-egg' };

  const { sub, checksum } = decryptSecure(raw);
  if (checksum !== u16(raw, 0x1c)) return { ok: false, reason: 'checksum' };

  const internal = u16(sub.G, 0);
  if (internal === 0) return { ok: false, reason: 'empty' };
  const ivEgg = u32(sub.M, 4);
  const isEgg = internal === GEN3_SPECIES_EGG || !!(ivEgg & (1 << 30)) || !!(flags & 0x4);
  const national = speciesMap.toNational(internal);
  if (!national) return { ok: false, reason: 'unknown-species' };

  const exp = u32(sub.G, 4);
  const origin = u16(sub.M, 2);
  const isParty = raw.length >= GEN3_PARTY_MON_SIZE;
  const mon: PokemonData = {
    uid: `${pid.toString(16).padStart(8, '0')}-${otId.toString(16).padStart(8, '0')}`,
    species: national,
    nickname: decodeGen3String(raw.subarray(0x08, 0x12)),
    level: isParty ? raw[0x54] : levelFromExp(national, exp),
    hp: isParty ? u16(raw, 0x56) : undefined,
    maxHp: isParty ? u16(raw, 0x58) : undefined,
    status: isParty ? decodeStatus(u32(raw, 0x50)) : 'ok',
    isEgg,
    otId,
    heldItem: u16(sub.G, 2),
    moves: [u16(sub.A, 0), u16(sub.A, 2), u16(sub.A, 4), u16(sub.A, 6)].filter(Boolean),
    metLocation: sub.M[1],
    metLevel: origin & 0x7f,
    ball: (origin >> 11) & 0xf,
    experience: exp,
    personality: pid,
    // Shiny when (TID ^ SID ^ PID-high ^ PID-low) < 8.
    shiny: ((otId & 0xffff) ^ (otId >>> 16) ^ (pid & 0xffff) ^ (pid >>> 16)) < 8,
  };
  return { ok: true, mon };
}

export interface Gen3PokemonSpec {
  personality: number;
  otId: number;
  species: number; // national
  nickname: string;
  level: number;
  hp: number;
  maxHp: number;
  status?: number;
  exp?: number;
  heldItem?: number;
  moves?: number[];
  metLocation?: number;
  metLevel?: number;
  ball?: number;
  isEgg?: boolean;
}

/** Builds an encrypted 100-byte party Pokémon. Used for tests and synthetic fixtures. */
export function encodeGen3Pokemon(spec: Gen3PokemonSpec, speciesMap: Gen3SpeciesMap = VANILLA_GEN3_SPECIES): Uint8Array {
  const out = new Uint8Array(GEN3_PARTY_MON_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, spec.personality >>> 0, true);
  dv.setUint32(4, spec.otId >>> 0, true);
  out.set(encodeGen3String(spec.nickname, 10), 0x08);
  out[0x12] = 2; // English
  out[0x13] = 0x2 | (spec.isEgg ? 0x4 : 0);
  out.set(encodeGen3String('LEE', 7), 0x14);

  const plain = new Uint8Array(48);
  const pdv = new DataView(plain.buffer);
  const order = ORDERS[(spec.personality >>> 0) % 24];
  const at = (letter: string) => order.indexOf(letter) * 12;
  pdv.setUint16(at('G'), speciesMap.fromNational(spec.species), true);
  pdv.setUint16(at('G') + 2, spec.heldItem ?? 0, true);
  pdv.setUint32(at('G') + 4, spec.exp ?? spec.level ** 3, true);
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => pdv.setUint16(at('A') + i * 2, m, true));
  plain[at('M') + 1] = spec.metLocation ?? 0;
  pdv.setUint16(at('M') + 2, ((spec.metLevel ?? spec.level) & 0x7f) | ((spec.ball ?? 4) << 11), true);
  pdv.setUint32(at('M') + 4, spec.isEgg ? 1 << 30 : 0, true);

  let checksum = 0;
  for (let i = 0; i < 48; i += 2) checksum = (checksum + pdv.getUint16(i, true)) & 0xffff;
  dv.setUint16(0x1c, checksum, true);
  const key = (spec.otId ^ spec.personality) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(0x20 + i, (pdv.getUint32(i, true) ^ key) >>> 0, true);

  dv.setUint32(0x50, spec.status ?? 0, true);
  out[0x54] = spec.level;
  dv.setUint16(0x56, spec.hp, true);
  dv.setUint16(0x58, spec.maxHp, true);
  return out;
}
