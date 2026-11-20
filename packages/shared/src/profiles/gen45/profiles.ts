/**
 * DS profiles. EXPERIMENTAL: the gen4/gen5 engines find the party by scanning RAM, so these
 * profiles mostly carry identity (game codes), typing era and notes. Location/badge addresses and
 * level caps aren't filled in yet — add them in the profile editor once verified on a real game.
 *
 * Hacks keep their base game's code, so they're matched by hash (add yours in the profile editor)
 * or picked explicitly when creating a run.
 */
import type { GameProfile } from '../types';

const NOTE = 'Experimental DS support: party, faints and catches are automatic; set your location with the "I\'m at" button. Unverified on real memory except where noted.';

const base = (id: string, name: string, generation: 4 | 5, codes: string[], notes = NOTE): GameProfile => ({
  id, name, generation, platform: 'nds', engine: generation === 4 ? 'gen4' : 'gen5',
  match: { gameCodes: codes }, addresses: {}, offsets: {}, locations: {}, notes,
});

const hack = (id: string, name: string, base: string, extra: Partial<GameProfile> = {}): GameProfile => ({
  id, name, extends: base, generation: 4, platform: 'nds', engine: 'gen4',
  match: { sha1: [] }, addresses: {}, offsets: {}, locations: {}, notes: `${NOTE} Hack profile: add your ROM's hash in the profile editor so it's detected automatically.`,
  ...extra,
});

export const DS_PROFILES: GameProfile[] = [
  base('platinum-us', 'Pokémon Platinum (US)', 4, ['CPUE', 'CPUP', 'CPUS', 'CPUF', 'CPUD', 'CPUI']),
  base('diamond-pearl-us', 'Pokémon Diamond / Pearl (US)', 4, ['ADAE', 'APAE']),
  base('hgss-us', 'Pokémon HeartGold / SoulSilver (US)', 4, ['IPKE', 'IPGE']),
  base('bw-us', 'Pokémon Black / White (US)', 5, ['IRBO', 'IRAO']),
  base('b2w2-us', 'Pokémon Black 2 / White 2 (US)', 5, ['IREO', 'IRDO']),
  // Drayano's hacks use Gen 6+ typings (Fairy type).
  hack('renegade-platinum', 'Renegade Platinum', 'platinum-us', { typingGeneration: 6 }),
  hack('sacred-gold', 'Sacred Gold', 'hgss-us', { typingGeneration: 6 }),
  hack('storm-silver', 'Storm Silver', 'hgss-us', { typingGeneration: 6 }),
  hack('blaze-black', 'Blaze Black (Redux)', 'bw-us', { generation: 5, engine: 'gen5', typingGeneration: 6 }),
  hack('volt-white', 'Volt White (Redux)', 'bw-us', { generation: 5, engine: 'gen5', typingGeneration: 6 }),
  hack('blaze-black-2', 'Blaze Black 2 / Volt White 2 Redux', 'b2w2-us', { generation: 5, engine: 'gen5', typingGeneration: 6 }),
  hack('vintage-white', 'Vintage White', 'bw-us', { generation: 5, engine: 'gen5' }),
];
