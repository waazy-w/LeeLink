import type { Platform } from '../memory/reader';

export interface RomInfo {
  platform: Platform;
  /** Internal header title, e.g. "POKEMON FIRE". */
  title: string;
  /** 4-char game code (GBA/DS), e.g. "BPRE"; for GB the title stands in. */
  gameCode: string;
  /** Header revision / mask ROM version. */
  revision: number;
  /** Lowercase hex SHA-1 of the whole file. Used to match ROMs across players without sharing them. */
  sha1: string;
  size: number;
}

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, start + len)).replace(/\0.*$/s, '').trim();

/** Detects platform from header structure, not file extension. */
export function detectPlatform(rom: Uint8Array): Platform | undefined {
  // GBA: fixed value 0x96 at 0xB2 and header complement check over 0xA0..0xBC.
  if (rom.length >= 0xc0 && rom[0xb2] === 0x96) {
    let chk = 0;
    for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff;
    if (((chk - 0x19) & 0xff) === rom[0xbd]) return 'gba';
  }
  // NDS: CRC16 of the Nintendo logo is always 0xCF56 at 0x15C.
  if (rom.length >= 0x200 && rom[0x15c] === 0x56 && rom[0x15d] === 0xcf) return 'nds';
  // GB/GBC: header checksum over 0x134..0x14C.
  if (rom.length >= 0x150) {
    let x = 0;
    for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
    if (x === rom[0x14d]) return rom[0x143] & 0x80 ? 'gbc' : 'gb';
  }
  return undefined;
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function identifyRom(rom: Uint8Array): Promise<RomInfo | undefined> {
  const platform = detectPlatform(rom);
  if (!platform) return undefined;
  const sha1 = await sha1Hex(rom);
  switch (platform) {
    case 'gba':
      return { platform, title: ascii(rom, 0xa0, 12), gameCode: ascii(rom, 0xac, 4), revision: rom[0xbc], sha1, size: rom.length };
    case 'nds':
      return { platform, title: ascii(rom, 0x00, 12), gameCode: ascii(rom, 0x0c, 4), revision: rom[0x1e], sha1, size: rom.length };
    default: {
      // GBC titles are 11 chars when a manufacturer code is present; 15/16 otherwise.
      const title = ascii(rom, 0x134, rom[0x143] & 0x80 ? 15 : 16);
      return { platform, title, gameCode: title, revision: rom[0x14c], sha1, size: rom.length };
    }
  }
}
