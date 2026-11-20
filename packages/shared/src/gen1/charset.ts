import { GEN1_CHARSET } from './charset-table';

/** String terminator ("@" in pret sources). */
export const GB_EOS = 0x50;

/** Shared by Gen 1 and Gen 2 (their English charsets differ only in a few symbols). */
export function decodeGbString(bytes: Uint8Array, table: readonly string[]): string {
  let out = '';
  for (const b of bytes) {
    if (b === GB_EOS) break;
    out += table[b] ?? '';
  }
  return out.trimEnd();
}

export function encodeGbString(text: string, length: number, table: readonly string[]): Uint8Array {
  const reverse = new Map<string, number>();
  table.forEach((ch, code) => ch && ch.length === 1 && !reverse.has(ch) && reverse.set(ch, code));
  const out = new Uint8Array(length).fill(GB_EOS);
  [...text].slice(0, length - 1).forEach((ch, i) => (out[i] = reverse.get(ch) ?? 0x7f));
  return out;
}

/** Decodes a Gen 1 (English) string, stopping at the 0x50 terminator. */
export const decodeGen1String = (bytes: Uint8Array) => decodeGbString(bytes, GEN1_CHARSET);
/** Encodes to the Gen 1 charset, terminated and padded with 0x50. Used by tests and fixture builders. */
export const encodeGen1String = (text: string, length: number) => encodeGbString(text, length, GEN1_CHARSET);
