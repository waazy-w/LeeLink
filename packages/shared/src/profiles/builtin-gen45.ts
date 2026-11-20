// Gen 4/5 (DS) profiles and engines, including ROM hack profiles. Registry imports this.
import type { GameProfile } from './types';
import type { EngineFactories } from './engine-types';
import { createGen4Reader, createGen5Reader } from '../gen4/reader';
import { DS_PROFILES } from './gen45/profiles';

export const GEN45_PROFILES: GameProfile[] = DS_PROFILES;
export const GEN45_ENGINES: EngineFactories = { gen4: createGen4Reader, gen5: createGen5Reader };
