import type { RomInfo } from '../rom/identify';
import type { GameProfile } from './types';
import firered from './gen3/firered.json';
import leafgreen from './gen3/leafgreen.json';
import emerald from './gen3/emerald.json';
import { GEN12_PROFILES } from './builtin-gen12';
import { GEN45_PROFILES } from './builtin-gen45';

export const BUILTIN_PROFILES: GameProfile[] = [
  firered as unknown as GameProfile,
  leafgreen as unknown as GameProfile,
  emerald as unknown as GameProfile,
  ...GEN12_PROFILES,
  ...GEN45_PROFILES,
];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge where objects merge key-by-key and arrays/scalars replace. */
export function deepMerge<T>(base: T, over: Partial<T>): T {
  if (!isObject(base) || !isObject(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export class ProfileRegistry {
  private byId = new Map<string, GameProfile>();

  constructor(profiles: GameProfile[] = BUILTIN_PROFILES) {
    profiles.forEach((p) => this.add(p));
  }

  add(p: GameProfile) {
    this.byId.set(p.id, p);
  }

  remove(id: string) {
    this.byId.delete(id);
  }

  raw(id: string) {
    return this.byId.get(id);
  }

  all(): GameProfile[] {
    return [...this.byId.keys()].map((id) => this.resolve(id)!);
  }

  /** Returns the profile with its `extends` chain applied. */
  resolve(id: string, seen = new Set<string>()): GameProfile | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    if (!p.extends) return p;
    if (seen.has(id)) throw new Error(`profile inheritance cycle at ${id}`);
    seen.add(id);
    const base = this.resolve(p.extends, seen);
    if (!base) throw new Error(`profile ${id} extends unknown profile ${p.extends}`);
    // A hack's own match rules replace the base's, never extend them.
    return { ...deepMerge(base, p), match: p.match, extends: p.extends };
  }

  /**
   * Best profile for a ROM: exact hash, then game code + revision, then game code alone.
   * Hacks usually keep the base game code, so a hash-matched hack profile wins over vanilla.
   */
  match(rom: RomInfo): { profile: GameProfile; confidence: 'exact' | 'code' | 'loose' } | undefined {
    const all = this.all();
    const exact = all.find((p) => p.match.sha1?.includes(rom.sha1));
    if (exact) return { profile: exact, confidence: 'exact' };
    const code = (p: GameProfile) => p.match.gameCodes?.includes(rom.gameCode) || p.match.titles?.includes(rom.title);
    const byRev = all.find((p) => code(p) && !p.extends && (p.match.revisions?.includes(rom.revision) ?? true));
    if (byRev) return { profile: byRev, confidence: 'code' };
    const loose = all.find((p) => code(p) && !p.extends);
    return loose ? { profile: loose, confidence: 'loose' } : undefined;
  }
}
