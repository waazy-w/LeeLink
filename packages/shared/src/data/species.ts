import { SPECIES_TABLE } from './species-table';

export type PokemonType =
  | 'normal' | 'fighting' | 'flying' | 'poison' | 'ground' | 'rock' | 'bug' | 'ghost' | 'steel'
  | 'fire' | 'water' | 'grass' | 'electric' | 'psychic' | 'ice' | 'dragon' | 'dark' | 'fairy';

export interface SpeciesInfo {
  /** National dex number. */
  id: number;
  name: string;
  /** Generation introduced. */
  gen: number;
  /** Evolution family id (shared by every member of an evolution line). */
  family: number;
  /** Pre-evolution national dex number, 0 if none. */
  from: number;
  /** Modern typing. */
  types: string[];
  /** Older typings keyed by the last generation they applied to. */
  pastTypes?: Record<string, string[]>;
  /** PokeAPI growth rate id (1 slow, 2 medium, 3 fast, 4 medium-slow, 5 erratic, 6 fluctuating). */
  growth: number;
  catchRate: number;
}

export const MAX_SPECIES = SPECIES_TABLE.length;

export function species(id: number): SpeciesInfo | undefined {
  return id >= 1 && id <= SPECIES_TABLE.length ? SPECIES_TABLE[id - 1] : undefined;
}

export function speciesName(id: number): string {
  return species(id)?.name ?? `#${id}`;
}

/** Typing as it was in the given generation (e.g. Clefairy is Normal before Gen 6). */
export function typesFor(id: number, gen: number): PokemonType[] {
  const s = species(id);
  if (!s) return [];
  if (s.pastTypes) {
    const applicable = Object.keys(s.pastTypes)
      .map(Number)
      .filter((g) => g >= gen)
      .sort((a, b) => a - b)[0];
    if (applicable !== undefined) return s.pastTypes[applicable] as PokemonType[];
  }
  return s.types as PokemonType[];
}

/** Total experience needed to reach `level` for a growth rate. */
export function expForLevel(growth: number, level: number): number {
  const n = level;
  if (n <= 1) return 0;
  switch (growth) {
    case 1: return Math.floor((5 * n ** 3) / 4);
    case 2: return n ** 3;
    case 3: return Math.floor((4 * n ** 3) / 5);
    case 4: return Math.floor((6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140);
    case 5:
      if (n <= 50) return Math.floor((n ** 3 * (100 - n)) / 50);
      if (n <= 68) return Math.floor((n ** 3 * (150 - n)) / 100);
      if (n <= 98) return Math.floor((n ** 3 * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((n ** 3 * (160 - n)) / 100);
    case 6:
      if (n <= 15) return Math.floor((n ** 3 * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((n ** 3 * (n + 14)) / 50);
      return Math.floor((n ** 3 * (Math.floor(n / 2) + 32)) / 50);
    default: return n ** 3;
  }
}

/** Level implied by total experience (used for boxed Pokémon, which don't store level). */
export function levelFromExp(speciesId: number, exp: number): number {
  const growth = species(speciesId)?.growth ?? 2;
  let level = 1;
  while (level < 100 && expForLevel(growth, level + 1) <= exp) level++;
  return level;
}
