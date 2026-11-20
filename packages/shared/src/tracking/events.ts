import type { PokemonData } from '../model';
import type { BattleResult } from '../profiles/types';

export interface PlaceRef {
  /** Engine location id (e.g. Gen 3 map section). */
  id: number;
  name: string;
  /** Nuzlocke area key used for "first encounter per area" and links. */
  area: string;
}

export interface MonRef {
  uid: string;
  species: number;
  nickname: string;
  level: number;
}

export interface DeathCause {
  kind: 'wild' | 'trainer' | 'other';
  trainerId?: number;
  trainerName?: string;
  /** Opponent on the field when the faint was observed. */
  enemySpecies?: number;
  enemyLevel?: number;
}

/** Facts observed in one player's game. The Soul Link engine turns these into run state. */
export type TrackerEvent =
  | { type: 'session'; trainer: { name: string; id: number } }
  | { type: 'location'; place: PlaceRef; from?: PlaceRef }
  | { type: 'encounter'; place: PlaceRef; species: number; level: number; shiny?: boolean }
  | { type: 'encounter-end'; place: PlaceRef; species: number; level: number; result: BattleResult }
  | { type: 'obtained'; place: PlaceRef; mon: PokemonData; method: 'caught' | 'gift' }
  | { type: 'faint'; place: PlaceRef; mon: MonRef; cause: DeathCause }
  | { type: 'revived'; mon: MonRef }
  | { type: 'evolved'; mon: MonRef; fromSpecies: number }
  | { type: 'badge'; index: number; count: number }
  | { type: 'trainer-battle'; place: PlaceRef; trainerId: number; trainerName?: string; result: BattleResult }
  | { type: 'whiteout'; place: PlaceRef }
  /** A party Pokémon survived a battle on very low HP. */
  | { type: 'close-call'; place: PlaceRef; mon: MonRef; hp: number; maxHp: number; cause: DeathCause };

export type TrackerEventType = TrackerEvent['type'];

export const monRef = (m: PokemonData): MonRef => ({ uid: m.uid, species: m.species, nickname: m.nickname, level: m.level });
