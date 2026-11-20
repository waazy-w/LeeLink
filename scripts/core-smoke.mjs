// Headless smoke test: boot a ROM in the mGBA core, run frames, dump a BMP screenshot.
// usage: node scripts/core-smoke.mjs <rom> <frames> <out.bmp>
import { readFileSync, writeFileSync } from 'node:fs';
import createMgbaCore from '../apps/web/public/cores/mgba/leelink-mgba.js';

const [romPath, framesArg = '600', out = '/tmp/shot.bmp'] = process.argv.slice(2);
const wasmBinary = readFileSync(new URL('../apps/web/public/cores/mgba/leelink-mgba.wasm', import.meta.url));
const m = await createMgbaCore({ wasmBinary });
const rom = readFileSync(romPath);
const ptr = m._ll_alloc(rom.length);
m.HEAPU8.set(rom, ptr);
const platform = m._ll_load(ptr, rom.length, 0, 0);
console.log('platform', platform, 'ok');
const t0 = performance.now();
let audio = 0;
const frames = +framesArg;
for (let i = 0; i < frames; i++) {
  // press A/start periodically to get through intro screens
  m._ll_set_keys(i % 60 < 5 ? (i % 120 < 60 ? 1 : 8) : 0);
  m._ll_run_frame();
  audio += m._ll_audio_drain();
}
const dt = performance.now() - t0;
console.log(`${frames} frames in ${dt.toFixed(0)}ms = ${(frames / dt * 1000).toFixed(0)} fps; audio frames ${audio}`);
const w = m._ll_video_width(), h = m._ll_video_height(), stride = m._ll_video_stride();
const vb = m._ll_video_buffer() >> 2;
const px = new Uint32Array(m.HEAPU8.buffer);
const row = w * 3 + ((4 - (w * 3) % 4) % 4);
const bmp = Buffer.alloc(54 + row * h);
bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(w, 18); bmp.writeInt32LE(-h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const c = px[vb + y * stride + x], o = 54 + y * row + x * 3;
  bmp[o] = (c >> 16) & 255; bmp[o + 1] = (c >> 8) & 255; bmp[o + 2] = c & 255;
}
writeFileSync(out, bmp);
console.log('wram ptr', m._ll_region_ptr(0), 'size', m._ll_region_size(0), 'iwram size', m._ll_region_size(1));
