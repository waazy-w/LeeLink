import { RegionMemoryReader, type MemoryRegion } from '@leelink/shared/memory/reader';
import type { Button, EmulatorCore, ScreenInfo } from './types';

/* Shape of our Emscripten module (cores/melonds/leelink_melonds.cpp). */
interface MelonModule {
  HEAPU8: Uint8Array;
  _ll_alloc(size: number): number;
  _ll_free(ptr: number): void;
  _ll_load(rom: number, size: number, save: number, saveSize: number): number;
  _ll_unload(): void;
  _ll_reset(): void;
  _ll_set_keys(keys: number): void;
  _ll_touch(x: number, y: number, down: number): void;
  _ll_run_frame(): void;
  _ll_video_buffer(): number;
  _ll_set_output_rate(rate: number): void;
  _ll_audio_drain(): number;
  _ll_audio_buffer(): number;
  _ll_region_ptr(region: number): number;
  _ll_region_size(region: number): number;
  _ll_read8(address: number): number;
  _ll_save_clone(): number;
  _ll_save_clone_ptr(): number;
  _ll_save_write_count(): number;
  _ll_state_save(): number;
  _ll_state_ptr(): number;
  _ll_state_load(ptr: number, size: number): number;
}

const KEY_BITS: Record<Button, number> = {
  a: 0, b: 1, select: 2, start: 3, right: 4, left: 5, up: 6, down: 7, r: 8, l: 9, x: 10, y: 11,
};
const W = 256;
const H = 192;

let modulePromise: Promise<MelonModule> | undefined;

async function loadModule(): Promise<MelonModule> {
  const url = '/cores/melonds/leelink-melonds.js';
  const factory = (await import(/* @vite-ignore */ url)).default as (opts: object) => Promise<MelonModule>;
  return factory({ locateFile: (f: string) => `/cores/melonds/${f}` });
}

export async function createMelonCore(rom: Uint8Array, save?: Uint8Array): Promise<EmulatorCore> {
  modulePromise ??= loadModule();
  const m = await modulePromise;

  const romPtr = m._ll_alloc(rom.length);
  m.HEAPU8.set(rom, romPtr);
  let savePtr = 0;
  if (save?.length) {
    savePtr = m._ll_alloc(save.length);
    m.HEAPU8.set(save, savePtr);
  }
  const kind = m._ll_load(romPtr, rom.length, savePtr, save?.length ?? 0);
  if (savePtr) m._ll_free(savePtr);
  if (!kind) throw new Error('melonDS could not load this ROM');

  const view = (region: number) => {
    const ptr = m._ll_region_ptr(region);
    return ptr ? new Uint8Array(m.HEAPU8.buffer, ptr, m._ll_region_size(region)) : new Uint8Array(0);
  };
  const regions: MemoryRegion[] = [{ name: 'main', base: 0x02000000, bytes: () => view(0) }];
  const memory = new RegionMemoryReader('nds', regions, (a) => m._ll_read8(a));
  let keys = 0;
  let disposed = false;

  return {
    platform: 'nds',
    fps: 33513982 / 560190,
    screens(): ScreenInfo[] {
      return [{ width: W, height: H }, { width: W, height: H }];
    },
    runFrame() {
      m._ll_set_keys(keys);
      m._ll_run_frame();
    },
    setButtons(pressed) {
      keys = 0;
      for (const b of pressed) keys |= 1 << KEY_BITS[b];
    },
    touch(x, y, down) {
      m._ll_touch(Math.round(x), Math.round(y), down ? 1 : 0);
    },
    readVideo(screen, out) {
      // RGBA, 256x384: top screen rows 0-191, bottom screen rows 192-383.
      const start = m._ll_video_buffer() + screen * W * H * 4;
      out.set(m.HEAPU8.subarray(start, start + W * H * 4));
    },
    setAudioRate(rate) {
      m._ll_set_output_rate(rate);
    },
    drainAudio() {
      const frames = m._ll_audio_drain();
      return new Int16Array(m.HEAPU8.buffer, m._ll_audio_buffer(), frames * 2);
    },
    memory,
    regions: () => regions,
    exportSave() {
      const size = m._ll_save_clone();
      return size ? m.HEAPU8.slice(m._ll_save_clone_ptr(), m._ll_save_clone_ptr() + size) : undefined;
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
