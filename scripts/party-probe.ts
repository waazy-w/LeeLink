// Boots a GBA ROM (+ optional save) headlessly, presses through to the overworld, and prints the party.
// usage: npx tsx scripts/party-probe.ts <rom> <save|-> <party-addr> <count-addr> [frames] [snapshot-out]
import { readFileSync, writeFileSync } from 'node:fs';
import { RegionMemoryReader, takeSnapshot, encodeSnapshot } from '../packages/shared/src/memory/reader';
import { readGen3Party } from '../packages/shared/src/gen3/party';
import { speciesName } from '../packages/shared/src/data/species';
// @ts-expect-error generated emscripten module
import createMgbaCore from '../apps/web/public/cores/mgba/leelink-mgba.js';

const [romPath, savePath, partyHex, countHex, framesArg = '1500', snapOut] = process.argv.slice(2);
const m = await createMgbaCore({ wasmBinary: readFileSync('apps/web/public/cores/mgba/leelink-mgba.wasm') });
const rom = readFileSync(romPath);
const rp = m._ll_alloc(rom.length); m.HEAPU8.set(rom, rp);
let sp = 0, ss = 0;
if (savePath !== '-') { const s = readFileSync(savePath); sp = m._ll_alloc(s.length); m.HEAPU8.set(s, sp); ss = s.length; }
console.log('platform', m._ll_load(rp, rom.length, sp, ss));
const A = 1, START = 8;
for (let i = 0; i < +framesArg; i++) {
  const phase = i % 90;
  m._ll_set_keys(phase < 4 ? (i < 600 ? START : A) : 0);
  m._ll_run_frame();
  m._ll_audio_drain();
}
const region = (id: number, name: string, base: number) => ({ name, base, bytes: () => new Uint8Array(m.HEAPU8.buffer, m._ll_region_ptr(id), m._ll_region_size(id)) });
const regions = [region(0, 'ewram', 0x02000000), region(1, 'iwram', 0x03000000)];
const mem = new RegionMemoryReader('gba', regions, (a) => m._ll_read8(a));
for (const s of readGen3Party(mem, { party: parseInt(partyHex, 16), partyCount: parseInt(countHex, 16) })) {
  console.log(s.slot, s.mon ? `${speciesName(s.mon.species)} "${s.mon.nickname}" Lv${s.mon.level} ${s.mon.hp}/${s.mon.maxHp} ${s.mon.status} met@${s.mon.metLocation}` : s.error);
}
if (snapOut) writeFileSync(snapOut, encodeSnapshot(takeSnapshot('gba', regions, 'probe')));
{
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
  writeFileSync('/tmp/probe.bmp', bmp);
}
if (process.env.GMAIN) {
  const g = parseInt(process.env.GMAIN, 16);
  console.log('callback1', mem.read32(g).toString(16), 'callback2', mem.read32(g + 4).toString(16), 'vblank', mem.read32(g + 0x20));
}
