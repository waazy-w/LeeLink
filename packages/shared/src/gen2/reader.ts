/**
 * Gen 2 (Gold/Silver/Crystal) GameState reader.
 *
 * Battle state comes from the game's own variables (pret/pokecrystal ram/wram.asm):
 *  - wBattleMode: 0 overworld, 1 wild, 2 trainer (cleared by CleanUpBattleRAM);
 *  - wBattleType: BATTLETYPE_* (tutorial / debug battles are reported as kind 'other');
 *  - wBattleResult: WIN 0, LOSE 1, DRAW 2 (also running away / the wild Pokémon fleeing), with
 *    bit 6 = caught Celebi and bit 7 = box full; a catch leaves WIN;
 *  - wWildMon: species caught by the last ball throw (0 if it broke free);
 *  - wOtherTrainerClass / wOtherTrainerID, wOTParty*, wEnemyMon, wCurOTMon, wCurBattleMon.
 * wBattleResult and wEnemyMon survive the end of the battle, which is when the outcome is derived.
 */
import type { MemoryReader } from '../memory/reader';
import type { PartySlot } from '../model';
import type { BattleResult, GameProfile, GameState, ProfileReader } from '../profiles/types';
import { memBe16, readGbList, type GbListEntry } from '../gen1/gb';
import { gbLocation } from '../gen1/reader';
import { GB_NAME_LENGTH } from '../gen1/pokemon';
import { decodeGen2String } from './charset';
import {
  decodeGen2BattleMon, decodeGen2Pokemon, gen2Dvs, GEN2_BATTLE_MON_SIZE, GEN2_BOX_MON_SIZE, GEN2_EGG, GEN2_MAX_SPECIES, GEN2_PARTY_MON_SIZE,
} from './pokemon';

const WILD_BATTLE = 1;
const TRAINER_BATTLE = 2;
const WIN = 0, LOSE = 1, DRAW = 2;
const RESULT_CAUGHT_CELEBI = 0x40;
const RESULT_FLAGS = 0xc0;

export function createGen2Reader(profile: GameProfile, mem: MemoryReader): ProfileReader {
  const a = profile.addresses;
  const o = profile.offsets;
  const nameLen = o.nameLength ?? GB_NAME_LENGTH;
  const partySize = o.partyMonSize ?? GEN2_PARTY_MON_SIZE;
  const boxSize = o.boxMonSize ?? GEN2_BOX_MON_SIZE;
  const battleSize = o.battleMonSize ?? GEN2_BATTLE_MON_SIZE;
  const caughtData = !!o.hasCaughtData;
  const maxSpecies = o.maxSpecies ?? GEN2_MAX_SPECIES;

  const decodeList = (entries: GbListEntry[] | undefined): PartySlot[] =>
    (entries ?? []).map((e) => {
      const res = decodeGen2Pokemon({ raw: e.raw, listSpecies: e.listSpecies, nickname: e.nickname, caughtData, maxSpecies });
      return res.ok ? { slot: e.index, mon: res.mon } : { slot: e.index, error: res.reason };
    });
  const partyList = () => readGbList(mem, { count: a.partyCount, species: a.partySpecies, mons: a.partyMons, ots: a.partyOTs, nicknames: a.partyNicknames }, 6, partySize, nameLen);
  // The current PC box lives in cartridge SRAM; only readable when the SRAM region is mapped.
  const boxList = () => readGbList(mem, { count: a.boxCount, species: a.boxSpecies, mons: a.boxMons, ots: a.boxOTs, nicknames: a.boxNicknames }, o.boxCapacity ?? 20, boxSize, nameLen);
  const otList = () => readGbList(mem, { count: a.otPartyCount, species: a.otPartySpecies, mons: a.otPartyMons, ots: a.otPartyOTs, nicknames: a.otPartyNicknames }, 6, partySize, nameLen);

  return {
    profile,
    read(opts = {}): GameState {
      const trainerName = decodeGen2String(mem.readBytes(a.playerName, nameLen));
      const trainerId = memBe16(mem, a.playerId);
      // The game timer runs from FinishContinueFunction / new game until the main menu is shown again.
      const timer = (mem.read8(a.gameTimerPaused) >> (o.gameTimerBit ?? 0)) & 1;
      const partyEntries = partyList();
      const inGame = timer === 1 && trainerName.length > 0 && partyEntries !== undefined;
      const party = inGame ? decodeList(partyEntries) : [];

      const mapGroup = mem.read8(a.mapGroup);
      const mapNum = mem.read8(a.mapNumber);
      const location = { ...gbLocation(profile, (mapGroup << 8) | mapNum), mapGroup, mapNum };
      const johto = mem.read8(a.johtoBadges);
      const kanto = mem.read8(a.kantoBadges);
      const badges = Array.from({ length: 16 }, (_, i) => inGame && (((i < 8 ? johto : kanto) >> (i & 7)) & 1) === 1);

      const enemyRaw = mem.readBytes(a.enemyMon, battleSize);
      const enemyRes = decodeGen2BattleMon(enemyRaw, maxSpecies);
      const enemyMon = enemyRes.ok ? enemyRes.mon : undefined;

      const mode = mem.read8(a.battleMode);
      const battleType = mem.read8(a.battleType);
      const linked = mem.read8(a.linkMode) !== 0;
      const outcome = mem.read8(a.battleResult);
      const active = inGame && (mode === WILD_BATTLE || mode === TRAINER_BATTLE);
      const battle: GameState['battle'] = {
        active,
        kind: 'none',
        enemy: [],
        outcome,
        result: 'none',
        activeSlots: [],
        flags: battleType,
      };

      // ---- outcome (only meaningful on the in-battle -> out-of-battle transition; stale afterwards)
      const caught = () => {
        if (!enemyMon || !enemyMon.hp) return false;
        if (outcome & RESULT_CAUGHT_CELEBI) return true;
        // The caught Pokémon keeps the wild DVs; party first, then the current box (Gen 2 inserts at 0).
        const dvs = gen2Dvs(enemyRaw, true);
        const owned = [...(partyEntries ?? []), ...(boxList() ?? [])];
        if (owned.some((e) => e.raw[0] === enemyRaw[0] && gen2Dvs(e.raw) === dvs && ((e.raw[6] << 8) | e.raw[7]) === trainerId)) return true;
        // Party full and SRAM not mapped: fall back to the ball-throw result byte.
        return mem.read8(a.wildMon) === enemyRaw[0];
      };
      const partyDown = party.length > 0 && party.every((s) => !s.mon || s.mon.isEgg || s.mon.hp === 0) && party.some((s) => s.mon && !s.mon.isEgg);
      let result: BattleResult = 'none';
      const code = outcome & ~RESULT_FLAGS;
      if (code === LOSE || partyDown) result = 'lost';
      else if (code === DRAW) result = 'ran';
      else if (code === WIN && enemyMon) result = caught() ? 'caught' : enemyMon && enemyMon.hp! > 0 ? 'other' : 'won';
      battle.result = inGame ? result : 'none';

      if (active) {
        if (linked) battle.kind = 'other';
        else if (mode === TRAINER_BATTLE) battle.kind = 'trainer';
        else battle.kind = battleType === o.battleTypeTutorial || battleType === o.battleTypeDebug ? 'other' : 'wild';

        let onField: { species: number; level: number } | undefined;
        if (mode === TRAINER_BATTLE) {
          if (!linked) battle.trainerId = (mem.read8(a.otherTrainerClass) << 8) | mem.read8(a.otherTrainerId);
          const entries = otList();
          battle.enemy = decodeList(entries).flatMap((s) => (s.mon ? [s.mon] : []));
          // wEnemyMon holds the previous battle's Pokémon until the first send-out; trust it only when
          // it agrees with the OT party slot it claims to be.
          const slot = entries?.[mem.read8(a.curOTMon)];
          if (enemyMon && slot && slot.raw[0] === enemyRaw[0] && slot.raw[0x1f] === enemyMon.level && gen2Dvs(slot.raw) === gen2Dvs(enemyRaw, true)) {
            onField = { species: enemyMon.species, level: enemyMon.level };
          }
        } else if (enemyMon && enemyRaw[0] === mem.read8(a.tempWildMonSpecies) && gen2Dvs(enemyRaw, true) !== 0) {
          // Wild: ClearBattleRAM zeroes wEnemyMonDVs at battle start, LoadEnemyMon fills them in.
          battle.enemy = [enemyMon];
          onField = { species: enemyMon.species, level: enemyMon.level };
        }
        battle.enemyActive = onField ? [onField] : [];
        const slot = mem.read8(a.curBattleMon);
        if (slot < party.length) battle.activeSlots = [slot];
      }

      const state: GameState = {
        inGame,
        frame: opts.frame ?? 0,
        trainer: inGame ? { name: trainerName, id: trainerId } : undefined,
        party,
        location,
        badges,
        battle,
      };
      if (opts.boxes && inGame) {
        const box = mem.read8(a.currentBox);
        state.boxes = decodeList(boxList()).flatMap((s) => (s.mon ? [{ box, slot: s.slot, mon: s.mon }] : []));
      }
      return state;
    },
  };
}

export { GEN2_EGG };
