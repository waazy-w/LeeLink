/** Run rule settings. Every "fix for the worst parts of Soul Link" is a toggle here. */
export interface RuleSettings {
  /** Failed-encounter handling when one player fails the catch on an area. */
  failedEncounter: 'classic' | 'retry-token' | 'orphan';
  /** Retry tokens per player for the whole run (retry-token mode). */
  retryTokens: number;

  /** Duplicate species families don't count as the area's encounter. */
  dupesClause: boolean;
  /** Whose catches make a species a dupe: your own, or anyone's in the run. */
  dupesScope: 'player' | 'run';
  /** Shiny encounters don't consume the area's encounter. */
  shinyClause: boolean;
  /** No two links in the combined active teams may share a primary type. */
  typeClause: boolean;

  /** Gifts (starter, fossils, in-game gifts) count as the area's encounter and get linked. */
  giftsAreEncounters: boolean;
  /** Deaths before a player's first wild encounter are ignored (forced rival losses etc.). */
  graceUntilFirstEncounter: boolean;

  /** Show level caps and warn when a party Pokémon is over the cap. */
  levelCaps: boolean;
  /** Badge numbers that act as pacing gates (e.g. [1,2,...,8]); empty = off. */
  pacingGates: number[];

  /** Revive shards: earned when the slowest player reaches a badge. */
  reviveShards: { enabled: boolean; perBadge: number; max: number };

  /** What a whiteout does. */
  wipe: 'ends-run' | 'kills-active-links';

  /** Emulator save states allowed in this run. */
  saveStates: boolean;

  /** Votes needed to accept a dispute. */
  disputeQuorum: 'majority' | 'unanimous';
}

export const PRESETS: Record<'classic' | 'casual' | 'hardcore', RuleSettings> = {
  classic: {
    failedEncounter: 'classic',
    retryTokens: 0,
    dupesClause: true,
    dupesScope: 'player',
    shinyClause: true,
    typeClause: true,
    giftsAreEncounters: true,
    graceUntilFirstEncounter: true,
    levelCaps: true,
    pacingGates: [],
    reviveShards: { enabled: false, perBadge: 0, max: 0 },
    wipe: 'ends-run',
    saveStates: false,
    disputeQuorum: 'majority',
  },
  casual: {
    failedEncounter: 'retry-token',
    retryTokens: 3,
    dupesClause: true,
    dupesScope: 'run',
    shinyClause: true,
    typeClause: false,
    giftsAreEncounters: true,
    graceUntilFirstEncounter: true,
    levelCaps: true,
    pacingGates: [1, 2, 3, 4, 5, 6, 7, 8],
    reviveShards: { enabled: true, perBadge: 0.5, max: 4 },
    wipe: 'kills-active-links',
    saveStates: false,
    disputeQuorum: 'majority',
  },
  hardcore: {
    failedEncounter: 'classic',
    retryTokens: 0,
    dupesClause: false,
    dupesScope: 'player',
    shinyClause: false,
    typeClause: true,
    giftsAreEncounters: false,
    graceUntilFirstEncounter: false,
    levelCaps: true,
    pacingGates: [],
    reviveShards: { enabled: false, perBadge: 0, max: 0 },
    wipe: 'ends-run',
    saveStates: false,
    disputeQuorum: 'unanimous',
  },
};

export type PresetName = keyof typeof PRESETS;
