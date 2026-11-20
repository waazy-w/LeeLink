/**
 * Gen 4 text: 16-bit character codes looked up in a game-wide table (generated from the
 * pokeplatinum charmap; HGSS uses the same table). 0xFFFF terminates a string, 0xE000 is a
 * line break, anything above the table is a control code and is skipped.
 */
import { GEN4_CHARSET } from './charset-table';

export const GEN4_EOS = 0xffff;

export function decodeGen4String(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (c === GEN4_EOS || c === 0) break;
    out += GEN4_CHARSET[c] ?? '';
  }
  return out.trim();
}

const REVERSE = new Map<string, number>();
// Prefer the half-width (international) glyphs over the full-width Japanese ones for encoding.
for (let code = GEN4_CHARSET.length - 1; code >= 0; code--) {
  const ch = GEN4_CHARSET[code];
  if (ch && (!REVERSE.has(ch) || code >= 0x121)) REVERSE.set(ch, code);
}

/** Encodes `text` into `chars` 16-bit slots, terminated with 0xFFFF. Used by tests and fixtures. */
export function encodeGen4String(text: string, chars: number): Uint8Array {
  const out = new Uint8Array(chars * 2);
  const dv = new DataView(out.buffer);
  const glyphs = [...text].slice(0, chars - 1);
  glyphs.forEach((ch, i) => dv.setUint16(i * 2, REVERSE.get(ch) ?? 0x01ac /* ? */, true));
  for (let i = glyphs.length; i < chars; i++) dv.setUint16(i * 2, GEN4_EOS, true);
  return out;
}
