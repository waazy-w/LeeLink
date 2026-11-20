/**
 * Gen 4 (DPPt / HGSS) Pokémon structure decoding. Gen 5 shares the container format and reuses
 * the crypto here (see ../gen5/pokemon.ts).
 *
 * Layout (pret/pokeplatinum include/struct_defs/pokemon.h; PKHeX PK4.cs / PokeCrypto.cs):
 *   0x00 personality u32
 *   0x04 u16 flags: bit0 partyDecrypted, bit1 boxDecrypted, bit2 checksumFailed ("bad egg")
 *   0x06 checksum u16 = sum of the 64 decrypted u16 words of 0x08..0x87
 *   0x08 four 32-byte blocks A/B/C/D, stored in the order ((personality >> 13) & 31) % 24,
 *        encrypted with the LCG x = x * 0x41C64E6D + 0x6073 seeded with the checksum
 *        (each u16 XOR'd with x >> 16).
 *   0x88 party-only battle stats (100 bytes Gen 4, 84 bytes Gen 5), encrypted with the same LCG
 *        seeded with the personality: 0x88 status u32, 0x8C level, 0x8E hp, 0x90 maxHp, ...
 *
 * Block offsets below are absolute (as if blocks were stored A,B,C,D), matching PKHeX:
 *   A 0x08 species, 0x0A item, 0x0C otId u32 (TID | SID << 16), 0x10 exp
 *   B 0x28 moves[4], 0x38 IVs u32 (bit30 egg, bit31 nicknamed), 0x40 fateful/gender/form,
 *     0x44 Pt/HGSS egg location, 0x46 Pt/HGSS met location
 *   C 0x48 nickname (11 chars), 0x5F origin game
 *   D 0x68 OT name (8 chars), 0x7E DP egg location, 0x80 DP met location, 0x83 ball,
 *     0x84 met level (bits 0-6) | OT gender (bit 7), 0x86 HGSS ball
 */
import type { MajorStatus, PokemonData } from '../model';
import { decodeGen4String, encodeGen4String } from './charset';

export const GEN4_PARTY_MON_SIZE = 236;
export const GEN4_BOX_MON_SIZE = 136;
/** National dex limit for Gen 4 (Arceus). */
export const GEN4_MAX_SPECIES = 493;

/** Block storage order per shuffle value: ORDERS[s][i] = block letter stored at position i. */
const ORDERS = [
  'ABCD', 'ABDC', 'ACBD', 'ACDB', 'ADBC', 'ADCB', 'BACD', 'BADC', 'BCAD', 'BCDA', 'BDAC', 'BDCA',
  'CABD', 'CADB', 'CBAD', 'CBDA', 'CDAB', 'CDBA', 'DABC', 'DACB', 'DBAC', 'DBCA', 'DCAB', 'DCBA',
];

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** XORs `words` u16 values starting at `offset` with the Gen 4/5 LCG keystream (in place). */
export function ndsCrypt(data: Uint8Array, offset: number, words: number, seed: number) {
  let x = seed >>> 0;
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 0x41c64e6d) + 0x6073) >>> 0;
    const o = offset + i * 2;
    if (o + 1 >= data.length) break;
    const k = x >>> 16;
    data[o] ^= k & 0xff;
    data[o + 1] ^= k >>> 8;
  }
}

export const shuffleIndex = (pid: number) => ((pid >>> 13) & 31) % 24;

/**
 * Decrypts a stored (encrypted, shuffled) structure into canonical A,B,C,D order.
 * Returns the plain bytes (same length as input) and the checksum computed over the blocks.
 *
 * Honours the in-place decryption flags at 0x04: while the game edits a Pokémon it XORs the data
 * in place and sets partyDecrypted (bit 0, battle stats) / boxDecrypted (bit 1, blocks). The
 * blocks stay shuffled either way (pokeplatinum src/pokemon.c, *_EnterDecryptionContext).
 */
export function ndsDecrypt(raw: Uint8Array): { plain: Uint8Array; checksum: number } {
  const pid = u32(raw, 0);
  const flags = u16(raw, 4);
  const work = raw.slice();
  if (!(flags & 0x2)) ndsCrypt(work, 0x08, 64, u16(raw, 0x06));
  if (!(flags & 0x1) && work.length > 0x88) ndsCrypt(work, 0x88, (work.length - 0x88) >> 1, pid);
  const plain = work.slice();
  const order = ORDERS[shuffleIndex(pid)];
  for (let pos = 0; pos < 4; pos++) {
    const block = order.charCodeAt(pos) - 65;
    plain.set(work.subarray(0x08 + pos * 32, 0x08 + pos * 32 + 32), 0x08 + block * 32);
  }
  let checksum = 0;
  for (let o = 0x08; o < 0x88; o += 2) checksum = (checksum + u16(plain, o)) & 0xffff;
  return { plain, checksum };
}

/** Inverse of ndsDecrypt: shuffles and encrypts a canonical structure, writing the checksum. */
export function ndsEncrypt(plain: Uint8Array): Uint8Array {
  const pid = u32(plain, 0);
  let checksum = 0;
  for (let o = 0x08; o < 0x88; o += 2) checksum = (checksum + u16(plain, o)) & 0xffff;
  const out = plain.slice();
  out[0x06] = checksum & 0xff;
  out[0x07] = checksum >>> 8;
  const order = ORDERS[shuffleIndex(pid)];
  for (let pos = 0; pos < 4; pos++) {
    const block = order.charCodeAt(pos) - 65;
    out.set(plain.subarray(0x08 + block * 32, 0x08 + block * 32 + 32), 0x08 + pos * 32);
  }
  ndsCrypt(out, 0x08, 64, checksum);
  if (out.length > 0x88) ndsCrypt(out, 0x88, (out.length - 0x88) >> 1, pid);
  return out;
}

/** Status condition bits (same encoding as Gen 3). */
export function decodeNdsStatus(raw: number): MajorStatus {
  if (raw & 0x7) return 'sleep';
  if (raw & 0x80) return 'toxic';
  if (raw & 0x08) return 'poison';
  if (raw & 0x10) return 'burn';
  if (raw & 0x20) return 'freeze';
  if (raw & 0x40) return 'paralysis';
  return 'ok';
}

export type NdsDecodeResult =
  | { ok: true; mon: PokemonData }
  | { ok: false; reason: 'empty' | 'checksum' | 'bad-egg' | 'unknown-species' };

export interface NdsDecodeOptions {
  maxSpecies: number;
  partySize: number;
  decodeString: (bytes: Uint8Array) => string;
  /** Met location from the decrypted structure (Gen 4 has two fields, Gen 5 one). */
  metLocation: (plain: Uint8Array) => number;
  ball: (plain: Uint8Array) => number;
}

/**
 * Shared Gen 4/5 decode. Rejects anything whose checksum doesn't match: reads can catch the game
 * mid-write, and the battle engine works on decrypted copies with the flags set, so the checksum
 * (computed over decrypted data either way) is what makes a structure trustworthy.
 */
export function decodeNdsPokemon(raw: Uint8Array, opt: NdsDecodeOptions): NdsDecodeResult {
  if (raw.length < GEN4_BOX_MON_SIZE) return { ok: false, reason: 'empty' };
  const pid = u32(raw, 0);
  const flags = u16(raw, 4);
  const stored = u16(raw, 6);
  if (pid === 0 && stored === 0 && flags === 0) return { ok: false, reason: 'empty' };
  if (flags & 0x4) return { ok: false, reason: 'bad-egg' };
  if (flags & ~0x7) return { ok: false, reason: 'checksum' }; // unused flag bits set: not a Pokémon

  const { plain, checksum } = ndsDecrypt(raw);
  if (checksum !== stored) return { ok: false, reason: 'checksum' };

  const species = u16(plain, 0x08);
  if (species === 0) return { ok: false, reason: 'empty' };
  if (species > opt.maxSpecies) return { ok: false, reason: 'unknown-species' };
  const ivs = u32(plain, 0x38);
  const otId = u32(plain, 0x0c);
  const isParty = raw.length >= opt.partySize;
  const level = plain[0x8c];
  const mon: PokemonData = {
    uid: `${pid.toString(16).padStart(8, '0')}-${otId.toString(16).padStart(8, '0')}`,
    species,
    nickname: opt.decodeString(plain.subarray(0x48, 0x48 + 22)),
    level: isParty ? level : 0,
    hp: isParty ? u16(plain, 0x8e) : undefined,
    maxHp: isParty ? u16(plain, 0x90) : undefined,
    status: isParty ? decodeNdsStatus(u32(plain, 0x88)) : 'ok',
    isEgg: !!(ivs & (1 << 30)),
    otId,
    heldItem: u16(plain, 0x0a),
    moves: [u16(plain, 0x28), u16(plain, 0x2a), u16(plain, 0x2c), u16(plain, 0x2e)].filter(Boolean),
    metLocation: opt.metLocation(plain),
    metLevel: plain[0x84] & 0x7f,
    ball: opt.ball(plain),
    experience: u32(plain, 0x10),
    personality: pid,
    shiny: ((otId & 0xffff) ^ (otId >>> 16) ^ (pid & 0xffff) ^ (pid >>> 16)) < 8,
  };
  return { ok: true, mon };
}

export const GEN4_DECODE: NdsDecodeOptions = {
  maxSpecies: GEN4_MAX_SPECIES,
  partySize: GEN4_PARTY_MON_SIZE,
  decodeString: decodeGen4String,
  // Pt/HGSS store locations beyond the DP range in the extended field; DP leave it 0.
  metLocation: (p) => u16(p, 0x46) || u16(p, 0x80),
  ball: (p) => p[0x86] || p[0x83],
};

/**
 * Decodes a Gen 4 party (236-byte) or box (136-byte) Pokémon. Box structures don't store the level;
 * callers derive it from experience (see levelFromExp) when they need it.
 */
export function decodeGen4Pokemon(raw: Uint8Array): NdsDecodeResult {
  return decodeNdsPokemon(raw, GEN4_DECODE);
}

export interface NdsPokemonSpec {
  personality: number;
  /** Full 32-bit trainer id (TID | SID << 16). */
  otId: number;
  species: number;
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

/** Writes the generation-independent fields of a canonical (decrypted, unshuffled) structure. */
export function fillNdsPlain(plain: Uint8Array, spec: NdsPokemonSpec) {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  dv.setUint32(0x00, spec.personality >>> 0, true);
  dv.setUint16(0x08, spec.species, true);
  dv.setUint16(0x0a, spec.heldItem ?? 0, true);
  dv.setUint32(0x0c, spec.otId >>> 0, true);
  dv.setUint32(0x10, spec.exp ?? spec.level ** 3, true);
  (spec.moves ?? [33]).slice(0, 4).forEach((m, i) => dv.setUint16(0x28 + i * 2, m, true));
  dv.setUint32(0x38, (spec.isEgg ? 1 << 30 : 0) >>> 0, true);
  plain[0x84] = (spec.metLevel ?? spec.level) & 0x7f;
  if (plain.length > 0x88) {
    dv.setUint32(0x88, spec.status ?? 0, true);
    plain[0x8c] = spec.level;
    dv.setUint16(0x8e, spec.hp, true);
    dv.setUint16(0x90, spec.maxHp, true);
  }
}

/** Builds an encrypted 236-byte Gen 4 party Pokémon (Platinum/HGSS field usage). Tests and fixtures only. */
export function encodeGen4Pokemon(spec: NdsPokemonSpec): Uint8Array {
  const plain = new Uint8Array(GEN4_PARTY_MON_SIZE);
  fillNdsPlain(plain, spec);
  plain.set(encodeGen4String(spec.nickname, 11), 0x48);
  plain.set(encodeGen4String('Lee', 8), 0x68);
  const dv = new DataView(plain.buffer);
  dv.setUint16(0x46, spec.metLocation ?? 0, true);
  plain[0x83] = spec.ball ?? 4;
  plain[0x86] = spec.ball ?? 4;
  plain[0x5f] = 10; // Platinum
  return ndsEncrypt(plain);
}
