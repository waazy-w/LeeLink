// Headless Game Boy / Game Boy Color driver for recording real memory fixtures (Gen 1/2).
// Resumes from a save state, runs an input script, writes a new state, a screenshot and
// optionally a memory snapshot + decoded game state.
//
// usage: npx tsx scripts/drive-gb.ts --rom <rom> [--in state] [--out state] [--snap out.llsnap] [--label text] [--profile id] "<script>"
// script tokens (space separated):
//   A B start select            tap button (4 frames down, 8 up)
//   A*10                        tap 10 times
//   up:32 down:16 left right    hold direction for N frames (default 16 = one tile)
//   A:120 B:60                  hold a button for N frames
//   w60                         wait 60 frames
//   until:battle / until:nobattle[:max]   run (tapping nothing) until the battle flag flips
//   grind:up,down[:max]         walk back and forth one tile at a time until a battle starts
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RegionMemoryReader, takeSnapshot, encodeSnapshot } from '../packages/shared/src/memory/reader';
import { identifyRom } from '../packages/shared/src/rom/identify';
import { ProfileRegistry } from '../packages/shared/src/profiles/registry';
import { createProfileReader } from '../packages/shared/src/profiles/engines';
import { speciesName } from '../packages/shared/src/data/species';
import { gbRegions } from '../packages/shared/src/gen1/gb';
// @ts-expect-error generated emscripten module
import createMgbaCore from '../apps/web/public/cores/mgba/leelink-mgba.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rom: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' }, snap: { type: 'string' }, label: { type: 'string' },
    profile: { type: 'string' }, shot: { type: 'string', default: '/tmp/drive-gb.bmp' }, quiet: { type: 'boolean' },
  },
});
const romBytes = new Uint8Array(readFileSync(values.rom!));
const m = await createMgbaCore({ wasmBinary: readFileSync('apps/web/public/cores/mgba/leelink-mgba.wasm') });
const rp = m._ll_alloc(romBytes.length);
m.HEAPU8.set(romBytes, rp);
if (m._ll_load(rp, romBytes.length, 0, 0) !== 2) throw new Error('not a GB ROM');
if (values.in) {
  const st = readFileSync(values.in);
  const p = m._ll_alloc(st.length);
  m.HEAPU8.set(st, p);
  if (!m._ll_state_load(p, st.length)) throw new Error('state load failed');
  m._ll_free(p);
}

const view = (id: number) => () => new Uint8Array(m.HEAPU8.buffer, m._ll_region_ptr(id), m._ll_region_size(id));
const regions = gbRegions({ wram: view(0), hram: view(1), sram: m._ll_region_size(2) ? view(2) : undefined });
const info = (await identifyRom(romBytes))!;
const registry = new ProfileRegistry();
const profile = values.profile ? registry.resolve(values.profile)! : registry.match(info)!.profile;
const mem = new RegionMemoryReader(info.platform, regions, (a) => m._ll_read8(a));
const reader = createProfileReader(profile, mem)!;

const BITS: Record<string, number> = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7 };
const frame = (keys: number) => { m._ll_set_keys(keys); m._ll_run_frame(); m._ll_audio_drain(); };
for (const tok of (positionals[0] ?? '').split(/\s+/).filter(Boolean)) {
  let mm;
  if ((mm = tok.match(/^w(\d+)$/))) { for (let i = 0; i < +mm[1]; i++) frame(0); continue; }
  if ((mm = tok.match(/^until:(battle|nobattle)(?::(\d+))?$/))) {
    const want = mm[1] === 'battle';
    let i = 0;
    for (; i < +(mm[2] ?? 3000) && reader.read().battle.active !== want; i++) frame(0);
    if (!values.quiet) console.error(`until:${mm[1]} after ${i} frames`);
    continue;
  }
  if ((mm = tok.match(/^grind:(up|down|left|right),(up|down|left|right)(?::(\d+))?$/))) {
    // walk back and forth (one tile each way) until a battle starts
    let steps = 0;
    for (; steps < +(mm[3] ?? 200) && !reader.read().battle.active; steps++) {
      const dir = BITS[steps % 2 ? mm[2] : mm[1]];
      for (let i = 0; i < 16; i++) frame(1 << dir);
      for (let i = 0; i < 4 && !reader.read().battle.active; i++) frame(0);
    }
    if (!values.quiet) console.error(`grind: ${steps} steps`);
    continue;
  }
  if ((mm = tok.match(/^(up|down|left|right)(?::(\d+))?$/i)) || (mm = tok.match(/^(a|b)(?::(\d+))$/i))) { const n = +(mm[2] ?? 16); for (let i = 0; i < n; i++) frame(1 << BITS[mm[1].toLowerCase()]); frame(0); continue; }
  if ((mm = tok.match(/^(a|b|start|select)(?:\*(\d+))?$/i))) {
    for (let k = 0; k < +(mm[2] ?? 1); k++) { for (let i = 0; i < 4; i++) frame(1 << BITS[mm[1].toLowerCase()]); for (let i = 0; i < 8; i++) frame(0); }
    continue;
  }
  throw new Error(`bad token ${tok}`);
}

if (values.out) {
  const size = m._ll_state_save();
  writeFileSync(values.out, m.HEAPU8.slice(m._ll_state_ptr(), m._ll_state_ptr() + size));
}

const state = reader.read({ boxes: true });
const mon = (e: { species: number; nickname?: string; level: number; hp?: number; maxHp?: number; status?: string; isEgg?: boolean }) =>
  `${e.isEgg ? 'EGG ' : ''}${speciesName(e.species)}${e.nickname ? ` "${e.nickname}"` : ''} Lv${e.level} ${e.hp}/${e.maxHp}${e.status && e.status !== 'ok' ? ' ' + e.status : ''}`;
console.log(JSON.stringify({
  profile: profile.id,
  inGame: state.inGame, trainer: state.trainer, location: state.location, badges: state.badges.filter(Boolean).length,
  battle: { ...state.battle, enemy: state.battle.enemy.map(mon) },
  party: state.party.map((s) => (s.mon ? mon(s.mon) : s.error)),
  boxes: state.boxes?.map((b) => `${b.box}/${b.slot} ${mon(b.mon)}`),
}));
if (values.snap) writeFileSync(values.snap, encodeSnapshot(takeSnapshot(info.platform, regions, values.label, info.title)));

const w = m._ll_video_width(), h = m._ll_video_height(), stride = m._ll_video_stride(), vb = m._ll_video_buffer() >> 2;
const px = new Uint32Array(m.HEAPU8.buffer);
const row = w * 3 + ((4 - (w * 3) % 4) % 4);
const bmp = Buffer.alloc(54 + row * h);
bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(w, 18); bmp.writeInt32LE(-h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const c = px[vb + y * stride + x], o = 54 + y * row + x * 3;
  bmp[o] = (c >> 16) & 255; bmp[o + 1] = (c >> 8) & 255; bmp[o + 2] = c & 255;
}
writeFileSync(values.shot!, bmp);
