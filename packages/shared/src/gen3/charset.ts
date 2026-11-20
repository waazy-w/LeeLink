import { GEN3_CHARSET } from './charset-table';

const EOS = 0xff;

/** Decodes a Gen 3 western-charset string, stopping at the 0xFF terminator. */
export function decodeGen3String(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === EOS) break;
    out += GEN3_CHARSET[b] ?? '';
  }
  return out.trimEnd();
}

const REVERSE = new Map<string, number>();
GEN3_CHARSET.forEach((ch, code) => {
  if (ch && !REVERSE.has(ch)) REVERSE.set(ch, code);
});

/** Encodes to Gen 3 charset, padded with 0xFF to `length`. Used by tests and fixture builders. */
export function encodeGen3String(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length).fill(EOS);
  [...text].slice(0, length).forEach((ch, i) => (out[i] = REVERSE.get(ch) ?? 0));
  return out;
}
