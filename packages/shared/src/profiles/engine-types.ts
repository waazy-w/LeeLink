import type { MemoryReader } from '../memory/reader';
import type { GameProfile, ProfileReader } from './types';

export type ReaderFactory = (profile: GameProfile, mem: MemoryReader) => ProfileReader;
export type EngineFactories = Partial<Record<GameProfile['engine'], ReaderFactory>>;
