import type { Platform } from '../memory/reader';
import type { PartySlot, PokemonData } from '../model';

export type Engine = 'gen1' | 'gen2' | 'gen3' | 'gen4' | 'gen5' | 'manual';

export interface LevelCap {
  /** Badge count at which this cap applies (cap holds until this badge is earned). */
  badge: number;
  label: string;
  level: number;
  trainerId?: number;
}

/**
 * A game profile is plain JSON data: addresses, struct offsets and lookup tables.
 * Code lives in the engine (one reader per generation); profiles only describe a game.
 * ROM hacks `extends` a base profile and override only what changed.
 */
export interface GameProfile {
  id: string;
  name: string;
  /** Base profile id; fields here are deep-merged over it. */
  extends?: string;
  generation: 1 | 2 | 3 | 4 | 5;
  platform: Platform;
  engine: Engine;
  match: {
    gameCodes?: string[];
    revisions?: number[];
    /** Exact ROM hashes (strongest match). */
    sha1?: string[];
    /** GB/GBC header titles. */
    titles?: string[];
  };
  /** Symbolic name -> bus address. */
  addresses: Record<string, number>;
  /** Struct field offsets, sizes and counts. */
  offsets: Record<string, number>;
  /** Code addresses used to identify game state (e.g. overworld callback). */
  code?: Record<string, number>;
  flags?: { badges?: number[]; trainerFlagsStart?: number };
  /** Location / map section id -> display name ("Route 1"). */
  locations: Record<string, string>;
  /**
   * Optional grouping of locations into Nuzlocke "areas" (e.g. all Mt. Moon floors -> one area).
   * Location id -> area key. Defaults to the location name.
   */
  areas?: Record<string, string>;
  trainers?: Record<string, { name: string; maxLevel?: number }>;
  levelCaps?: LevelCap[];
  /** Internal species index -> national dex, for hacks with expanded/reordered species. */
  speciesTable?: number[];
  /** Per-species type overrides for hacks that retype Pokémon (national dex -> types). */
  typeOverrides?: Record<string, string[]>;
  /** Use this generation's typings (e.g. 6 for hacks that add the Fairy type). */
  typingGeneration?: number;
  notes?: string;
}

export type BattleResult = 'none' | 'won' | 'lost' | 'draw' | 'ran' | 'caught' | 'fled' | 'other';

export interface BattleState {
  active: boolean;
  kind: 'none' | 'wild' | 'trainer' | 'other';
  /** Opponent party (wild battles: the encounter). */
  enemy: PokemonData[];
  trainerId?: number;
  /** Raw outcome code (engine-specific). May hold a stale value after the battle ends. */
  outcome: number;
  /** Outcome normalised by the engine; 'none' while undecided. */
  result: BattleResult;
  /** Party slot indexes of the player's active battler(s). */
  activeSlots: number[];
  /** Species currently on the field for the opponent (helps attribute deaths). */
  enemyActive?: { species: number; level: number }[];
  flags: number;
}

/** Everything the tracker needs from one memory sample, game-agnostic. */
export interface GameState {
  /** False at title screen, intro, or menus before the save is loaded. */
  inGame: boolean;
  frame: number;
  trainer?: { name: string; id: number };
  party: PartySlot[];
  /** Box contents. Only read occasionally (expensive). */
  boxes?: { box: number; slot: number; mon: PokemonData }[];
  location: { id: number; name: string; area: string; mapGroup?: number; mapNum?: number };
  badges: boolean[];
  battle: BattleState;
}

export interface ProfileReader {
  profile: GameProfile;
  read(opts?: { boxes?: boolean; frame?: number }): GameState;
}
