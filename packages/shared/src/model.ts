/** Game-agnostic view of a Pokémon, produced by every generation's decoder. */

export type MajorStatus = 'ok' | 'sleep' | 'poison' | 'toxic' | 'burn' | 'freeze' | 'paralysis';

export interface PokemonData {
  /** Stable identity across party/box moves: personality value (Gen 3+) or synthesized (Gen 1/2). */
  uid: string;
  /** National dex number. */
  species: number;
  nickname: string;
  level: number;
  /** Current HP, undefined for boxed Pokémon in games that don't store it. */
  hp?: number;
  maxHp?: number;
  status: MajorStatus;
  isEgg: boolean;
  /** Original trainer id (full 32 bits in Gen 3+). */
  otId: number;
  heldItem: number;
  moves: number[];
  /** Map section / location id where it was met, game-specific; resolved by the profile. */
  metLocation?: number;
  metLevel?: number;
  /** Ball id the Pokémon was caught in. */
  ball?: number;
  experience: number;
  /** Personality value (Gen 3+). */
  personality?: number;
  shiny?: boolean;
}

export interface DecodeError {
  slot: number;
  reason: 'checksum' | 'bad-egg' | 'unknown-species' | 'empty';
}

/** One party slot as read from memory. */
export interface PartySlot {
  slot: number;
  mon?: PokemonData;
  /** Set when the slot couldn't be decoded this sample (e.g. caught mid-write). */
  error?: string;
}
