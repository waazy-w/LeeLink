import type { MemoryReader } from '../memory/reader';
import type { GameProfile, ProfileReader } from './types';
import type { EngineFactories, ReaderFactory } from './engine-types';
import { createGen3Reader } from '../gen3/reader';
import { GEN12_ENGINES } from './builtin-gen12';
import { GEN45_ENGINES } from './builtin-gen45';

const ENGINES: EngineFactories = {
  gen3: createGen3Reader,
  ...GEN12_ENGINES,
  ...GEN45_ENGINES,
};

export function registerEngine(engine: GameProfile['engine'], factory: ReaderFactory) {
  ENGINES[engine] = factory;
}

/** Returns a reader for the profile's engine, or undefined (=> manual mode). */
export function createProfileReader(profile: GameProfile, mem: MemoryReader): ProfileReader | undefined {
  return ENGINES[profile.engine]?.(profile, mem);
}
