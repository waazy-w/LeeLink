// Headless DS game driver (melonDS core) for playing to a point and recording real memory fixtures.
// Resumes from a save state, runs an input script, then writes a new state, a PNG screenshot of
// both screens, the decoded GameState and optionally a memory snapshot.
//
// usage: npx tsx scripts/drive-ds.ts --rom <rom.nds> [--in state] [--out state] [--snap out.llsnap]
//          [--label text] [--shot /tmp/drive-ds.png] [--profile id] [--sparse] "<script>"
// script tokens (space separated):
//   A B X Y L R start select    tap button (6 frames down, 10 up); A*10 taps 10 times
//   up:32 down:16 left right    hold direction for N frames (default 16 = one tile at walking speed)
//   B+up:32                     hold B (run) together with a direction
//   t:128,96[:N]                touch the bottom screen at pixel (x,y) for N frames (default 12)
//   w60                         wait 60 frames
//   shot:/tmp/x.png             write a screenshot now (mid-script)
// --sparse snapshots only the 4 KiB pages the reader touched (+ neighbours) instead of all 4 MiB
// of main RAM, which keeps committed fixtures small.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { RegionMemoryReader, encodeSnapshot, type MemoryReader, type MemorySnapshot } from '../packages/shared/src/memory/reader';
import { identifyRom } from '../packages/shared/src/rom/identify';
import type { GameProfile, ProfileReader } from '../packages/shared/src/profiles/types';
import { speciesName } from '../packages/shared/src/data/species';
// @ts-expect-error generated emscripten module
import createMelonDSCore from '../apps/web/public/cores/melonds/leelink-melonds.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rom: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' }, snap: { type: 'string' },
    label: { type: 'string' }, shot: { type: 'string', default: '/tmp/drive-ds.png' }, profile: { type: 'string' },
    sparse: { type: 'boolean', default: false }, quiet: { type: 'boolean', default: false },
  },
});

const romBytes = new Uint8Array(readFileSync(values.rom!));
const m = await createMelonDSCore({ wasmBinary: readFileSync(new URL('../apps/web/public/cores/melonds/leelink-melonds.wasm', import.meta.url)) });
{
  const rp = m._ll_alloc(romBytes.length);
  m.HEAPU8.set(romBytes, rp);
  if (m._ll_load(rp, romBytes.length, 0, 0) !== 3) throw new Error('ROM load failed');
}
if (values.in) {
  const st = readFileSync(values.in);
  const p = m._ll_alloc(st.length);
  m.HEAPU8.set(st, p);
  if (!m._ll_state_load(p, st.length)) throw new Error('state load failed');
  m._ll_free(p);
}

const BITS: Record<string, number> = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9, x: 10, y: 11 };
let frames = 0;
const frame = (keys: number) => { m._ll_set_keys(keys); m._ll_run_frame(); m._ll_audio_drain(); frames++; };

function png(path: string) {
  const w = m._ll_video_width(), h = m._ll_video_height(), vb = m._ll_video_buffer();
  const px = m.HEAPU8.subarray(vb, vb + w * h * 4);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const t0 = performance.now();
for (const tok of (positionals[0] ?? '').split(/\s+/).filter(Boolean)) {
  let mm: RegExpMatchArray | null;
  if ((mm = tok.match(/^w(\d+)$/))) { for (let i = 0; i < +mm[1]; i++) frame(0); continue; }
  if ((mm = tok.match(/^shot:(.+)$/))) { png(mm[1]); continue; }
  if ((mm = tok.match(/^t:(\d+),(\d+)(?::(\d+))?$/))) {
    m._ll_touch(+mm[1], +mm[2], 1);
    for (let i = 0; i < +(mm[3] ?? 12); i++) frame(0);
    m._ll_touch(0, 0, 0);
    for (let i = 0; i < 10; i++) frame(0);
    continue;
  }
  if ((mm = tok.match(/^(?:(b)\+)?(up|down|left|right)(?::(\d+))?$/i))) {
    const extra = mm[1] ? 1 << BITS.b : 0;
    const n = +(mm[3] ?? 16);
    for (let i = 0; i < n; i++) frame((1 << BITS[mm[2].toLowerCase()]) | extra);
    frame(0);
    continue;
  }
  if ((mm = tok.match(/^(a|b|x|y|l|r|start|select)(?:\*(\d+))?$/i))) {
    for (let k = 0; k < +(mm[2] ?? 1); k++) { for (let i = 0; i < 6; i++) frame(1 << BITS[mm[1].toLowerCase()]); for (let i = 0; i < 10; i++) frame(0); }
    continue;
  }
  throw new Error(`bad token ${tok}`);
}
const dt = performance.now() - t0;
if (frames) console.error(`${frames} frames in ${dt.toFixed(0)} ms = ${((frames / dt) * 1000).toFixed(1)} fps`);

if (values.out) {
  const size = m._ll_state_save();
  writeFileSync(values.out, m.HEAPU8.slice(m._ll_state_ptr(), m._ll_state_ptr() + size));
}
png(values.shot!);

// ---- decode the current state
const MAIN = 0x02000000;
const mainRegion = { name: 'main', base: MAIN, bytes: () => new Uint8Array(m.HEAPU8.buffer, m._ll_region_ptr(0), m._ll_region_size(0)) };
const live = new RegionMemoryReader('nds', [mainRegion], (a) => m._ll_read8(a));
// Records every main-RAM page the reader touches so --sparse can snapshot just those.
const touched = new Set<number>();
const mark = (a: number, n: number) => { for (let p = (a >>> 12); p <= ((a + n - 1) >>> 12); p++) touched.add(p); };
const tracing: MemoryReader = {
  platform: 'nds',
  read8: (a) => (mark(a, 1), live.read8(a)),
  read16: (a) => (mark(a, 2), live.read16(a)),
  read32: (a) => (mark(a, 4), live.read32(a)),
  readBytes: (a, n) => (mark(a, n), live.readBytes(a, n)),
};
const info = (await identifyRom(romBytes))!;
let profile: GameProfile | undefined;
let reader: ProfileReader | undefined;
try {
  // Imported lazily so a broken profile elsewhere in the registry never stops the emulator driver.
  const { ProfileRegistry } = await import('../packages/shared/src/profiles/registry');
  const { createProfileReader } = await import('../packages/shared/src/profiles/engines');
  const registry = new ProfileRegistry();
  profile = values.profile ? registry.resolve(values.profile) : registry.match(info)?.profile;
  reader = profile && createProfileReader(profile, tracing);
} catch (e) {
  console.error(`profile registry unavailable: ${(e as Error).message.split('\n')[0]}`);
}
if (reader) {
  const state = reader.read({ boxes: true, frame: m._ll_frame_counter() });
  const mon = (e: { species: number; nickname: string; level: number; hp?: number; maxHp?: number; status: string }) =>
    `${speciesName(e.species)} "${e.nickname}" Lv${e.level} ${e.hp}/${e.maxHp} ${e.status}`;
  if (!values.quiet) console.log(JSON.stringify({
    profile: profile!.id, inGame: state.inGame, trainer: state.trainer, location: state.location,
    badges: state.badges.filter(Boolean).length,
    battle: { ...state.battle, enemy: state.battle.enemy.map(mon) },
    party: state.party.map((s) => (s.mon ? mon(s.mon) : s.error)),
    boxes: state.boxes?.map((b) => `${b.box}/${b.slot} ${mon(b.mon)}`),
  }, null, 1));
} else {
  console.log(`no reader for ${info.gameCode} ${info.title}`);
}

if (values.snap) {
  const ram = mainRegion.bytes();
  let regions: MemorySnapshot['regions'];
  if (values.sparse) {
    // Neighbouring pages too, so small pointer drifts in replayed code paths stay covered.
    const pages = new Set<number>();
    for (const p of touched) for (const q of [p - 1, p, p + 1]) if (q >= MAIN >>> 12 && q < (MAIN + ram.length) >>> 12) pages.add(q);
    const sorted = [...pages].sort((x, y) => x - y);
    regions = [];
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      const base = sorted[i] << 12, end = (sorted[j] + 1) << 12;
      regions.push({ name: `main@${base.toString(16)}`, base, data: ram.slice(base - MAIN, end - MAIN) });
      i = j + 1;
    }
  } else {
    regions = [{ name: 'main', base: MAIN, data: ram.slice() }];
  }
  writeFileSync(values.snap, encodeSnapshot({ platform: 'nds', label: values.label, gameCode: info.gameCode, regions }));
  console.error(`snapshot: ${regions.length} region(s), ${regions.reduce((n, r) => n + r.data.length, 0)} bytes`);
}
