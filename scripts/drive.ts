// Headless game driver for recording real memory fixtures.
// Resumes from a save state, runs an input script, writes a new state, a screenshot and
// optionally a memory snapshot + decoded game state.
//
// usage: npx tsx scripts/drive.ts --rom <rom> [--in state] [--out state] [--snap out.llsnap] [--label text] "<script>"
// script tokens (space separated):
//   A B L R start select        tap button (4 frames down, 8 up)
//   A*10                        tap 10 times
//   up:32 down:16 left right    hold direction for N frames (default 16 = one tile)
//   w60                         wait 60 frames
//   ff600                       fast wait 600 frames while tapping nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RegionMemoryReader, takeSnapshot, encodeSnapshot } from '../packages/shared/src/memory/reader';
import { identifyRom } from '../packages/shared/src/rom/identify';
import { ProfileRegistry } from '../packages/shared/src/profiles/registry';
import { createProfileReader } from '../packages/shared/src/profiles/engines';
import { speciesName } from '../packages/shared/src/data/species';
// @ts-expect-error generated emscripten module
import createMgbaCore from '../apps/web/public/cores/mgba/leelink-mgba.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rom: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' }, snap: { type: 'string' }, label: { type: 'string' }, shot: { type: 'string', default: '/tmp/drive.bmp' }, 'save-out': { type: 'string' } },
});
const romBytes = new Uint8Array(readFileSync(values.rom!));
const m = await createMgbaCore({ wasmBinary: readFileSync('apps/web/public/cores/mgba/leelink-mgba.wasm') });
const rp = m._ll_alloc(romBytes.length);
m.HEAPU8.set(romBytes, rp);
m._ll_load(rp, romBytes.length, 0, 0);
if (values.in) {
  const st = readFileSync(values.in);
  const p = m._ll_alloc(st.length);
  m.HEAPU8.set(st, p);
  if (!m._ll_state_load(p, st.length)) throw new Error('state load failed');
  m._ll_free(p);
}

const BITS: Record<string, number> = { a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9 };
const frame = (keys: number) => { m._ll_set_keys(keys); m._ll_run_frame(); m._ll_audio_drain(); };
for (const tok of (positionals[0] ?? '').split(/\s+/).filter(Boolean)) {
  let mm;
  if ((mm = tok.match(/^w(\d+)$/)) || (mm = tok.match(/^ff(\d+)$/))) { for (let i = 0; i < +mm[1]; i++) frame(0); continue; }
  if ((mm = tok.match(/^(up|down|left|right)(?::(\d+))?$/i))) { const n = +(mm[2] ?? 16); for (let i = 0; i < n; i++) frame(1 << BITS[mm[1].toLowerCase()]); frame(0); continue; }
  if ((mm = tok.match(/^(a|b|l|r|start|select)(?:\*(\d+))?$/i))) {
    for (let k = 0; k < +(mm[2] ?? 1); k++) { for (let i = 0; i < 4; i++) frame(1 << BITS[mm[1].toLowerCase()]); for (let i = 0; i < 8; i++) frame(0); }
    continue;
  }
  throw new Error(`bad token ${tok}`);
}

if (values['save-out']) {
  const n = m._ll_save_clone();
  writeFileSync(values['save-out'], m.HEAPU8.slice(m._ll_save_clone_ptr(), m._ll_save_clone_ptr() + n));
  console.error('save bytes', n);
}
if (values.out) {
  const size = m._ll_state_save();
  writeFileSync(values.out, m.HEAPU8.slice(m._ll_state_ptr(), m._ll_state_ptr() + size));
}

const region = (id: number, name: string, base: number) => ({ name, base, bytes: () => new Uint8Array(m.HEAPU8.buffer, m._ll_region_ptr(id), m._ll_region_size(id)) });
const regions = [region(0, 'ewram', 0x02000000), region(1, 'iwram', 0x03000000)];
const mem = new RegionMemoryReader('gba', regions, (a) => m._ll_read8(a));
const info = (await identifyRom(romBytes))!;
const profile = new ProfileRegistry().match(info)!.profile;
const state = createProfileReader(profile, mem)!.read({ boxes: true });
const sb1 = mem.read32(profile.addresses.saveBlock1Ptr);
const pos = [mem.read16(sb1), mem.read16(sb1 + 2)];
console.log(JSON.stringify({
  pos,
  inGame: state.inGame, trainer: state.trainer, location: state.location, badges: state.badges.filter(Boolean).length,
  battle: { ...state.battle, enemy: state.battle.enemy.map((e) => `${speciesName(e.species)} Lv${e.level} ${e.hp}/${e.maxHp}`) },
  party: state.party.map((s) => (s.mon ? `${speciesName(s.mon.species)} "${s.mon.nickname}" Lv${s.mon.level} ${s.mon.hp}/${s.mon.maxHp} ${s.mon.status}` : s.error)),
  boxes: state.boxes?.length,
}));
if (values.snap) writeFileSync(values.snap, encodeSnapshot(takeSnapshot('gba', regions, values.label, info.gameCode)));

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
