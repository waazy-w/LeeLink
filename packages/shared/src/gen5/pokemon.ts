/**
 * Gen 5 (BW / B2W2) Pokémon: same container and crypto as Gen 4 (see ../gen4/pokemon.ts) with a
 * 220-byte party struct, UTF-16 nicknames and a single met-location field (PKHeX PK5.cs).
 */
import { decodeNdsPokemon, type NdsDecodeOptions, type NdsDecodeResult } from '../gen4/pokemon';

export const GEN5_PARTY_MON_SIZE = 220;
export const GEN5_MAX_SPECIES = 649;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

export function decodeGen5String(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = u16(bytes, i);
    if (c === 0xffff || c === 0) break;
    out += String.fromCharCode(c);
  }
  return out.trimEnd();
}

export const GEN5_DECODE: NdsDecodeOptions = {
  maxSpecies: GEN5_MAX_SPECIES,
  partySize: GEN5_PARTY_MON_SIZE,
  decodeString: decodeGen5String,
  metLocation: (p) => u16(p, 0x80),
  ball: (p) => p[0x83],
};

export function decodeGen5Pokemon(raw: Uint8Array): NdsDecodeResult {
  return decodeNdsPokemon(raw, GEN5_DECODE);
}
