/**
 * Shared Game Boy (Gen 1 / Gen 2) helpers: the bus layout the GB readers expect, big-endian field
 * access and the "count + species list + structs + OT names + nicknames" lists both generations use.
 */
import type { MemoryReader, MemoryRegion } from '../memory/reader';
import type { MajorStatus } from '../model';

/**
 * Bus layout used by GB profiles and snapshots:
 *  - WRAM at 0xC000 with all banks linear (bank 0 at 0xC000, bank 1 at 0xD000, GBC banks 2-7 at
 *    0xE000-0x11FFF; only banks 0/1 are used by the trackers);
 *  - HRAM at 0xFF80;
 *  - cartridge SRAM at 0x20000 + bank * 0x2000 (virtual; Gen 2 keeps the current PC box there).
 *
 * Note the SRAM window must not overlap the linear WRAM banks above 0xE000.
 */
export const GB_WRAM_BASE = 0xc000;
export const GB_HRAM_BASE = 0xff80;
export const GB_SRAM_BASE = 0x20000;

/** Maps a pret symbol (bank:address) to the bus address used by GB profiles. */
export function gbBusAddress(bank: number, addr: number): number {
  if (addr >= 0xc000 && addr < 0xd000) return addr;
  if (addr >= 0xd000 && addr < 0xe000) return bank <= 1 ? addr : 0xd000 + bank * 0x1000 - 0x1000 + (addr - 0xd000);
  if (addr >= 0xa000 && addr < 0xc000) return GB_SRAM_BASE + bank * 0x2000 + (addr - 0xa000);
  if (addr >= 0xff80) return addr;
  throw new Error(`not a RAM address: ${bank}:${addr.toString(16)}`);
}

/**
 * Builds the GB memory regions from raw buffers (mGBA core: region 0 = WRAM, 1 = HRAM, 2 = SRAM).
 * Pass `sram` when available so Gen 2 can read the current PC box.
 */
export function gbRegions(get: { wram: () => Uint8Array; hram: () => Uint8Array; sram?: () => Uint8Array }): MemoryRegion[] {
  const regions: MemoryRegion[] = [
    { name: 'wram', base: GB_WRAM_BASE, bytes: get.wram },
    { name: 'hram', base: GB_HRAM_BASE, bytes: get.hram },
  ];
  if (get.sram) regions.push({ name: 'sram', base: GB_SRAM_BASE, bytes: get.sram });
  return regions;
}

export const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const be24 = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
export const memBe16 = (mem: MemoryReader, a: number) => (mem.read8(a) << 8) | mem.read8(a + 1);

/** Non-volatile status byte, same in Gen 1 and 2 (bits 0-2 sleep counter). Toxic is battle-only. */
export function decodeGbStatus(raw: number): MajorStatus {
  if (raw & 0x07) return 'sleep';
  if (raw & 0x08) return 'poison';
  if (raw & 0x10) return 'burn';
  if (raw & 0x20) return 'freeze';
  if (raw & 0x40) return 'paralysis';
  return 'ok';
}

export interface GbListAddresses {
  count: number;
  species: number;
  mons: number;
  ots: number;
  nicknames: number;
}

export interface GbListEntry {
  index: number;
  /** Value in the species list (Gen 2: 0xFD for eggs). */
  listSpecies: number;
  raw: Uint8Array;
  ot: Uint8Array;
  nickname: Uint8Array;
}

/**
 * Reads a GB Pokémon list. Returns undefined when the header is implausible (count over capacity, or
 * the species list isn't 0xFF-terminated right after `count` entries): uninitialised RAM, a different
 * game, or a list caught mid-write.
 */
export function readGbList(mem: MemoryReader, a: GbListAddresses, capacity: number, monSize: number, nameLength: number): GbListEntry[] | undefined {
  const count = mem.read8(a.count);
  if (count > capacity) return undefined;
  const species = mem.readBytes(a.species, count + 1);
  if (species[count] !== 0xff) return undefined;
  const mons = mem.readBytes(a.mons, count * monSize);
  const ots = mem.readBytes(a.ots, count * nameLength);
  const nicks = mem.readBytes(a.nicknames, count * nameLength);
  const out: GbListEntry[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      index: i,
      listSpecies: species[i],
      raw: mons.subarray(i * monSize, (i + 1) * monSize),
      ot: ots.subarray(i * nameLength, (i + 1) * nameLength),
      nickname: nicks.subarray(i * nameLength, (i + 1) * nameLength),
    });
  }
  return out;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

/**
 * Gen 1/2 Pokémon have no personality value. OT id + DVs (+ Crystal caught data) never change for a
 * given Pokémon (not on evolution, deposit or nickname), so they form its identity.
 */
export function gbUid(gen: 1 | 2, otId: number, dvs: number, extra = 0): string {
  return `g${gen}-${hex4(otId)}-${hex4(dvs)}${extra ? `-${hex4(extra)}` : ''}`;
}
