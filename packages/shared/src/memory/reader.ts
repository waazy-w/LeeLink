/**
 * The single interface between emulator cores and game logic.
 * Game profiles only ever see a MemoryReader; cores and recorded snapshots both implement it.
 */
export type Platform = 'gb' | 'gbc' | 'gba' | 'nds';

export interface MemoryReader {
  readonly platform: Platform;
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  /** Copies `length` bytes starting at `address`. */
  readBytes(address: number, length: number): Uint8Array;
}

/** A contiguous block of emulated memory at a fixed bus address. */
export interface MemoryRegion {
  name: string;
  base: number;
  /** Returns a live view; may be called again if the backing buffer is replaced. */
  bytes(): Uint8Array;
}

/**
 * Reads through directly-mapped regions (zero copy), falling back to a slow per-byte
 * bus read for unmapped addresses. Little-endian, matching GB/GBA/DS.
 */
export class RegionMemoryReader implements MemoryReader {
  constructor(
    readonly platform: Platform,
    private readonly regions: MemoryRegion[],
    private readonly busRead8?: (address: number) => number,
  ) {}

  private locate(address: number, length: number): [Uint8Array, number] | undefined {
    for (const r of this.regions) {
      const bytes = r.bytes();
      const off = address - r.base;
      if (off >= 0 && off + length <= bytes.length) return [bytes, off];
    }
    return undefined;
  }

  read8(address: number): number {
    const hit = this.locate(address >>> 0, 1);
    if (hit) return hit[0][hit[1]];
    return this.busRead8 ? this.busRead8(address >>> 0) & 0xff : 0;
  }

  read16(address: number): number {
    const hit = this.locate(address >>> 0, 2);
    if (hit) return hit[0][hit[1]] | (hit[0][hit[1] + 1] << 8);
    return this.read8(address) | (this.read8(address + 1) << 8);
  }

  read32(address: number): number {
    const hit = this.locate(address >>> 0, 4);
    if (hit) {
      const [b, o] = hit;
      return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    }
    return (this.read16(address) | (this.read16(address + 2) << 16)) >>> 0;
  }

  readBytes(address: number, length: number): Uint8Array {
    const hit = this.locate(address >>> 0, length);
    if (hit) return hit[0].slice(hit[1], hit[1] + length);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.read8(address + i);
    return out;
  }
}

/** A frozen copy of memory regions: used for recorded test fixtures and diffing. */
export interface MemorySnapshot {
  platform: Platform;
  /** Optional note, e.g. "wild Pidgey battle, Route 1". */
  label?: string;
  gameCode?: string;
  regions: { name: string; base: number; data: Uint8Array }[];
}

export function snapshotReader(snap: MemorySnapshot): MemoryReader {
  return new RegionMemoryReader(
    snap.platform,
    snap.regions.map((r) => ({ name: r.name, base: r.base, bytes: () => r.data })),
  );
}

/** Captures copies of the given regions from a live reader. */
export function takeSnapshot(platform: Platform, regions: MemoryRegion[], label?: string, gameCode?: string): MemorySnapshot {
  return { platform, label, gameCode, regions: regions.map((r) => ({ name: r.name, base: r.base, data: r.bytes().slice() })) };
}

/**
 * Binary snapshot format (.llsnap): JSON header line, then raw region bytes in order.
 * Compact enough to commit as test fixtures.
 */
export function encodeSnapshot(snap: MemorySnapshot): Uint8Array {
  const header = JSON.stringify({
    v: 1, platform: snap.platform, label: snap.label, gameCode: snap.gameCode,
    regions: snap.regions.map((r) => ({ name: r.name, base: r.base, length: r.data.length })),
  });
  const head = new TextEncoder().encode(header + '\n');
  const total = head.length + snap.regions.reduce((n, r) => n + r.data.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let off = head.length;
  for (const r of snap.regions) { out.set(r.data, off); off += r.data.length; }
  return out;
}

export function decodeSnapshot(buf: Uint8Array): MemorySnapshot {
  const nl = buf.indexOf(10);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(0, nl)));
  let off = nl + 1;
  const regions = header.regions.map((r: { name: string; base: number; length: number }) => {
    const data = buf.slice(off, off + r.length);
    off += r.length;
    return { name: r.name, base: r.base, data };
  });
  return { platform: header.platform, label: header.label, gameCode: header.gameCode, regions };
}
