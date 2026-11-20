import type { MemoryReader } from '../memory/reader';
import type { PokemonData } from '../model';
import type { BattleResult, GameProfile, GameState, ProfileReader } from '../profiles/types';
import { decodeGen3String } from './charset';
import { readGen3Party } from './party';
import { decodeGen3Pokemon, GEN3_BOX_MON_SIZE, GEN3_PARTY_MON_SIZE, VANILLA_GEN3_SPECIES, type Gen3SpeciesMap } from './pokemon';

const EWRAM_START = 0x02000000;
const EWRAM_END = 0x02040000;
const BATTLE_TYPE_TRAINER = 1 << 3;
/** struct BattlePokemon is 0x58 bytes; species at 0x00, level at 0x2A. */
const BATTLE_MON_SIZE = 0x58;
/** B_OUTCOME_* from include/constants/battle.h (same in R/S/E/FR/LG). */
const OUTCOMES: Record<number, BattleResult> = {
  1: 'won', 2: 'lost', 3: 'draw', 4: 'ran', 5: 'ran', 6: 'fled', 7: 'caught', 8: 'other', 9: 'lost', 10: 'fled',
};

export function gen3SpeciesMap(profile: GameProfile): Gen3SpeciesMap {
  const table = profile.speciesTable;
  if (!table) return VANILLA_GEN3_SPECIES;
  const reverse = new Map<number, number>();
  table.forEach((nat, idx) => nat && !reverse.has(nat) && reverse.set(nat, idx));
  return { toNational: (i) => table[i] ?? 0, fromNational: (n) => reverse.get(n) ?? 0 };
}

export function locationInfo(profile: GameProfile, id: number) {
  const name = profile.locations[id] ?? `Area ${id}`;
  return { id, name, area: profile.areas?.[id] ?? name };
}

export function createGen3Reader(profile: GameProfile, mem: MemoryReader): ProfileReader {
  const a = profile.addresses;
  const o = profile.offsets;
  const species = gen3SpeciesMap(profile);
  const inEwram = (p: number) => p >= EWRAM_START && p < EWRAM_END;

  const readFlag = (sb1: number, flag: number) => {
    const byte = mem.read8(sb1 + o.sb1Flags + (flag >> 3));
    return ((byte >> (flag & 7)) & 1) === 1;
  };

  const decodeMany = (addr: number, count: number, size: number): PokemonData[] => {
    const bytes = mem.readBytes(addr, count * size);
    const out: PokemonData[] = [];
    for (let i = 0; i < count; i++) {
      const res = decodeGen3Pokemon(bytes.subarray(i * size, (i + 1) * size), species);
      if (res.ok) out.push(res.mon);
    }
    return out;
  };

  // Saves are loaded into RAM at the Continue menu, before the player is actually in the game.
  // Only report "in game" once the overworld (or a battle) has run since the last reset.
  let reachedGameplay = false;
  const gameplayCallbacks = [profile.code?.CB2_Overworld, profile.code?.BattleMainCB2].filter((x): x is number => !!x);

  return {
    profile,
    read(opts = {}): GameState {
      const sb1 = mem.read32(a.saveBlock1Ptr);
      const sb2 = mem.read32(a.saveBlock2Ptr);
      const valid = inEwram(sb1) && inEwram(sb2);
      const trainerName = valid ? decodeGen3String(mem.readBytes(sb2 + o.sb2PlayerName, 8)) : '';
      const trainerId = valid ? mem.read32(sb2 + o.sb2TrainerId) : 0;
      // Before a save is loaded or a new game is named, the save blocks are blank.
      const loaded = valid && trainerName.length > 0 && trainerId !== 0;
      if (!loaded) reachedGameplay = false;
      else if (!gameplayCallbacks.length || gameplayCallbacks.includes((mem.read32(a.main + o.mainCallback2) & ~1) >>> 0)) reachedGameplay = true;
      const inGame = loaded && reachedGameplay;

      const mapsec = mem.read8(a.mapHeader + o.mapHeaderMapsec);
      const location = {
        ...locationInfo(profile, mapsec),
        mapGroup: valid ? mem.read8(sb1 + o.sb1Location) : undefined,
        mapNum: valid ? mem.read8(sb1 + o.sb1Location + 1) : undefined,
      };

      const badges = (profile.flags?.badges ?? []).map((f) => (valid ? readFlag(sb1, f) : false));

      const inBattle = (mem.read8(a.main + o.mainInBattle) & (o.mainInBattleMask ?? 2)) !== 0;
      const flags = mem.read32(a.battleTypeFlags);
      const battle: GameState['battle'] = {
        active: inGame && inBattle,
        kind: 'none',
        enemy: [],
        outcome: mem.read8(a.battleOutcome),
        result: 'none',
        activeSlots: [],
        flags,
      };
      battle.result = OUTCOMES[battle.outcome & 0x7f] ?? 'none';
      if (battle.active) {
        battle.kind = flags & BATTLE_TYPE_TRAINER ? 'trainer' : 'wild';
        battle.enemy = decodeMany(a.enemyParty, 6, GEN3_PARTY_MON_SIZE);
        if (battle.kind === 'trainer') battle.trainerId = mem.read16(a.trainerOpponentA);
        const count = Math.min(mem.read8(a.battlersCount), 4);
        const enemyActive: { species: number; level: number }[] = [];
        for (let b = 0; b < count; b++) {
          // Battler positions alternate player (even) / opponent (odd).
          if (b % 2 === 0) battle.activeSlots.push(mem.read16(a.battlerPartyIndexes + b * 2));
          else {
            const base = a.battleMons + b * BATTLE_MON_SIZE;
            const nat = species.toNational(mem.read16(base));
            if (nat) enemyActive.push({ species: nat, level: mem.read8(base + 0x2a) });
          }
        }
        battle.enemyActive = enemyActive;
      }

      const state: GameState = {
        inGame,
        frame: opts.frame ?? 0,
        trainer: inGame ? { name: trainerName, id: trainerId } : undefined,
        party: inGame ? readGen3Party(mem, { party: a.party, partyCount: a.partyCount }, species) : [],
        location,
        badges,
        battle,
      };

      if (opts.boxes && inGame) {
        const storage = mem.read32(a.storagePtr);
        if (inEwram(storage)) {
          const boxCount = o.storageBoxCount ?? 14;
          const boxSize = o.storageBoxSize ?? 30;
          const bytes = mem.readBytes(storage + o.storageBoxes, boxCount * boxSize * GEN3_BOX_MON_SIZE);
          state.boxes = [];
          for (let i = 0; i < boxCount * boxSize; i++) {
            const res = decodeGen3Pokemon(bytes.subarray(i * GEN3_BOX_MON_SIZE, (i + 1) * GEN3_BOX_MON_SIZE), species);
            if (res.ok) state.boxes.push({ box: Math.floor(i / boxSize), slot: i % boxSize, mon: res.mon });
          }
        }
      }
      return state;
    },
  };
}
