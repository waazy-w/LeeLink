// Headless smoke test for the melonDS core: boot a DS ROM, run frames, dump both screens.
// usage: node scripts/ds-smoke.mjs <rom.nds> [frames=1200] [out.bmp=/tmp/ds.bmp]
import { readFileSync, writeFileSync } from 'node:fs';
import createMelonDSCore from '../apps/web/public/cores/melonds/leelink-melonds.js';

const [romPath, framesArg = '1200', out = '/tmp/ds.bmp'] = process.argv.slice(2);
const wasmBinary = readFileSync(new URL('../apps/web/public/cores/melonds/leelink-melonds.wasm', import.meta.url));
const m = await createMelonDSCore({ wasmBinary });
const rom = readFileSync(romPath);
const ptr = m._ll_alloc(rom.length);
m.HEAPU8.set(rom, ptr);
const platform = m._ll_load(ptr, rom.length, 0, 0);
console.log('platform', platform, 'main RAM', m._ll_region_size(0), 'save size', m._ll_region_size(2));
if (!platform) process.exit(1);

const frames = +framesArg;
let audio = 0;
const t0 = performance.now();
for (let i = 0; i < frames; i++) {
  // Tap A then Start alternately every second to get through intro screens.
  const phase = i % 120;
  m._ll_set_keys(phase < 6 ? 1 : phase >= 60 && phase < 66 ? 8 : 0);
  m._ll_run_frame();
  audio += m._ll_audio_drain();
}
const dt = performance.now() - t0;
console.log(`${frames} frames in ${dt.toFixed(0)}ms = ${(frames / dt * 1000).toFixed(1)} fps (DS runs at ~59.83); audio frames ${audio} (${(audio / frames).toFixed(0)}/frame)`);

// Dump 256x384 RGBA buffer as 24-bit BMP.
const w = m._ll_video_width(), h = m._ll_video_height();
const vb = m._ll_video_buffer();
const px = m.HEAPU8.subarray(vb, vb + w * h * 4);
const row = w * 3;
const bmp = Buffer.alloc(54 + row * h);
bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
bmp.writeInt32LE(w, 18); bmp.writeInt32LE(-h, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
for (let i = 0; i < w * h; i++) {
  const o = 54 + i * 3;
  bmp[o] = px[i * 4 + 2]; bmp[o + 1] = px[i * 4 + 1]; bmp[o + 2] = px[i * 4];
}
writeFileSync(out, bmp);
let nonzero = 0;
const ram = m.HEAPU8.subarray(m._ll_region_ptr(0), m._ll_region_ptr(0) + m._ll_region_size(0));
for (const b of ram) if (b) nonzero++;
console.log('main RAM nonzero bytes', nonzero, 'read8(0x02000000)', m._ll_read8(0x02000000), '=', ram[0]);
