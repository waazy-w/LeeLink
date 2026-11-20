import type { MemoryReader, MemoryRegion, Platform } from '@leelink/shared/memory/reader';

export type Button =
  | 'a' | 'b' | 'select' | 'start' | 'right' | 'left' | 'up' | 'down' | 'r' | 'l' | 'x' | 'y';

export const BUTTONS: Button[] = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l', 'x', 'y'];

export interface ScreenInfo {
  width: number;
  height: number;
}

/**
 * What every emulator core (mGBA, melonDS) provides to the app.
 * Game logic never touches this directly; it gets `memory` (a MemoryReader).
 */
export interface EmulatorCore {
  readonly platform: Platform;
  /** Native frames per second (≈59.73 for GB/GBA, ≈59.83 for DS). */
  readonly fps: number;
  /** One entry per screen (DS has two, stacked top then bottom). */
  screens(): ScreenInfo[];
  runFrame(): void;
  setButtons(pressed: ReadonlySet<Button>): void;
  /** DS touch screen, coordinates in bottom-screen pixels. */
  touch?(x: number, y: number, down: boolean): void;
  /** Writes the current frame for `screen` into an RGBA buffer of width*height*4. */
  readVideo(screen: number, out: Uint8ClampedArray): void;
  setAudioRate(rate: number): void;
  /** Returns interleaved stereo int16 samples produced since the last call (view; copy if kept). */
  drainAudio(): Int16Array;
  readonly memory: MemoryReader;
  regions(): MemoryRegion[];
  /** Current battery save bytes, or undefined if the game has no save. */
  exportSave(): Uint8Array | undefined;
  saveState(): Uint8Array | undefined;
  loadState(state: Uint8Array): boolean;
  reset(): void;
  dispose(): void;
}
