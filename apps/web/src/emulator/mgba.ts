import { RegionMemoryReader, type MemoryRegion, type Platform } from '@leelink/shared/memory/reader';
import type { Button, EmulatorCore, ScreenInfo } from './types';

/* Shape of our Emscripten module (cores/mgba/leelink_mgba.c). */
interface MgbaModule {
  HEAPU8: Uint8Array;
  _ll_alloc(size: number): number;
  _ll_free(ptr: number): void;
  _ll_load(rom: number, size: number, save: number, saveSize: number): number;
  _ll_unload(): void;
  _ll_reset(): void;
  _ll_set_keys(keys: number): void;
  _ll_run_frame(): void;
  _ll_video_buffer(): number;
  _ll_video_stride(): number;
  _ll_video_width(): number;
  _ll_video_height(): number;
  _ll_set_output_rate(rate: number): void;
  _ll_audio_drain(): number;
  _ll_audio_buffer(): number;
  _ll_region_ptr(region: number): number;
  _ll_region_size(region: number): number;
  _ll_read8(address: number): number;
  _ll_save_clone(): number;
  _ll_save_clone_ptr(): number;
  _ll_state_save(): number;
  _ll_state_ptr(): number;
  _ll_state_load(ptr: number, size: number): number;
}

const KEY_BITS: Partial<Record<Button, number>> = {
  a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9,
};

const REGION = { WRAM: 0, IWRAM: 1, SAVE: 2, ROM: 3 } as const;

let modulePromise: Promise<MgbaModule> | undefined;

async function loadModule(): Promise<MgbaModule> {
  // Served from /public so it's not processed by the bundler.
  const url = '/cores/mgba/leelink-mgba.js';
  const factory = (await import(/* @vite-ignore */ url)).default as (opts: object) => Promise<MgbaModule>;
  return factory({ locateFile: (f: string) => `/cores/mgba/${f}` });
}

export async function createMgbaCore(rom: Uint8Array, save?: Uint8Array, platformHint?: Platform): Promise<EmulatorCore> {
  // One module instance per page; ll_load replaces any previous game.
  modulePromise ??= loadModule();
  const m = await modulePromise;

  const romPtr = m._ll_alloc(rom.length); // ownership passes to the core
  m.HEAPU8.set(rom, romPtr);
  let savePtr = 0;
  if (save?.length) {
    savePtr = m._ll_alloc(save.length);
    m.HEAPU8.set(save, savePtr);
  }
  const kind = m._ll_load(romPtr, rom.length, savePtr, save?.length ?? 0);
  if (savePtr) m._ll_free(savePtr);
  if (!kind) throw new Error('mGBA could not load this ROM');

  const platform: Platform = kind === 1 ? 'gba' : platformHint === 'gb' ? 'gb' : 'gbc';
  // Emscripten may replace HEAPU8 when memory grows, so views are always rebuilt from m.HEAPU8.
  const view = (region: number) => {
    const ptr = m._ll_region_ptr(region);
    const size = m._ll_region_size(region);
    return ptr ? new Uint8Array(m.HEAPU8.buffer, ptr, size) : new Uint8Array(0);
  };
  let regionList: MemoryRegion[];
  if (kind === 1) {
    regionList = [
      { name: 'ewram', base: 0x02000000, bytes: () => view(REGION.WRAM) },
      { name: 'iwram', base: 0x03000000, bytes: () => view(REGION.IWRAM) },
    ];
  } else {
    // GB WRAM is banked: bank 0 at 0xC000, the switchable bank at 0xD000. The linear region
    // covers bank 0 + bank 1 (all DMG games and most GBC game state); other banks use bus reads.
    regionList = [
      { name: 'wram', base: 0xc000, bytes: () => view(REGION.WRAM).subarray(0, 0x2000) },
      { name: 'hram', base: 0xff80, bytes: () => view(REGION.IWRAM) },
    ];
  }
  const memory = new RegionMemoryReader(platform, regionList, (a) => m._ll_read8(a));

  let keys = 0;
  let disposed = false;

  return {
    platform,
    fps: kind === 1 ? 16777216 / 280896 : 4194304 / 70224,
    screens(): ScreenInfo[] {
      return [{ width: m._ll_video_width(), height: m._ll_video_height() }];
    },
    runFrame() {
      m._ll_set_keys(keys);
      m._ll_run_frame();
    },
    setButtons(pressed) {
      keys = 0;
      for (const b of pressed) {
        const bit = KEY_BITS[b];
        if (bit !== undefined) keys |= 1 << bit;
      }
    },
    readVideo(_screen, out) {
      const w = m._ll_video_width();
      const h = m._ll_video_height();
      const stride = m._ll_video_stride();
      const src = new Uint32Array(m.HEAPU8.buffer, m._ll_video_buffer(), stride * h);
      const dst = new Uint32Array(out.buffer, out.byteOffset, w * h);
      // mGBA writes 0x00BBGGRR; canvas wants RGBA bytes = 0xAABBGGRR little-endian.
      for (let y = 0; y < h; y++) {
        const so = y * stride, d = y * w;
        for (let x = 0; x < w; x++) dst[d + x] = src[so + x] | 0xff000000;
      }
    },
    setAudioRate(rate) {
      m._ll_set_output_rate(rate);
    },
    drainAudio() {
      const frames = m._ll_audio_drain();
      return new Int16Array(m.HEAPU8.buffer, m._ll_audio_buffer(), frames * 2);
    },
    memory,
    regions: () => regionList,
    exportSave() {
      const size = m._ll_save_clone();
      if (!size) return undefined;
      return m.HEAPU8.slice(m._ll_save_clone_ptr(), m._ll_save_clone_ptr() + size);
    },
    saveState() {
      const size = m._ll_state_save();
      return size ? m.HEAPU8.slice(m._ll_state_ptr(), m._ll_state_ptr() + size) : undefined;
    },
    loadState(state) {
      const p = m._ll_alloc(state.length);
      m.HEAPU8.set(state, p);
      const ok = m._ll_state_load(p, state.length) === 1;
      m._ll_free(p);
      return ok;
    },
    reset() {
      m._ll_reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      m._ll_unload();
    },
  };
}
