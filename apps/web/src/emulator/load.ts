import type { RomInfo } from '@leelink/shared/rom/identify';
import type { EmulatorCore } from './types';

/** Picks the core for a ROM's platform. Cores are loaded lazily so only the needed one downloads. */
export async function createCore(info: RomInfo, rom: Uint8Array, save?: Uint8Array): Promise<EmulatorCore> {
  if (info.platform === 'nds') {
    const { createMelonCore } = await import('./melonds');
    return createMelonCore(rom, save);
  }
  const { createMgbaCore } = await import('./mgba');
  return createMgbaCore(rom, save, info.platform);
}
