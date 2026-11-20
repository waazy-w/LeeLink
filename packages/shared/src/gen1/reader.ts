/**
 * Gen 1 (Red/Blue/Yellow) GameState reader.
 *
 * Battle state comes from the game's own variables (pret/pokered ram/wram.asm):
 *  - wIsInBattle: 0 none, 1 wild, 2 trainer, $FF lost (set after the battle ends, before blackout);
 *  - wBattleResult: 0 win, 1 lose, 2 "draw" (player ran, or a Pokémon was caught);
 *  - wEnemyMonSpecies2 + wCurEnemyLevel: the wild Pokémon being encountered; wTrainerClass / wTrainerNo;
 *  - wEnemyMon: the active opposing battler; wEnemyMonPartyPos its OT party slot.
 * EndOfBattle clears wIsInBattle/wCurOpponent but leaves wBattleResult and wEnemyMon, which is what the
 * outcome is derived from on the in-battle -> out-of-battle transition.
 */
import type { MemoryReader } from '../memory/reader';
import type { PartySlot, PokemonData } from '../model';
import type { BattleResult, GameProfile, GameState, ProfileReader } from '../profiles/types';
import { decodeGen1String } from './charset';
import { memBe16, readGbList, type GbListEntry } from './gb';
import {
  decodeGen1BattleMon, decodeGen1Pokemon, gen1Dvs, GEN1_BATTLE_MON_SIZE, GEN1_BOX_MON_SIZE, GEN1_PARTY_MON_SIZE, GB_NAME_LENGTH,
} from './pokemon';

const WILD_BATTLE = 1;
const TRAINER_BATTLE = 2;
const OPP_ID_OFFSET = 200;

export function gbLocation(profile: GameProfile, id: number) {
  const name = profile.locations[id] ?? `Map ${id}`;
  return { id, name, area: profile.areas?.[id] ?? name };
}

export function decodeGen1List(entries: GbListEntry[] | undefined): PartySlot[] {
  return (entries ?? []).map((e) => {
    const res = decodeGen1Pokemon({ raw: e.raw, listSpecies: e.listSpecies, nickname: e.nickname });
    return res.ok ? { slot: e.index, mon: res.mon } : { slot: e.index, error: res.reason };
  });
}

export function createGen1Reader(profile: GameProfile, mem: MemoryReader): ProfileReader {
  const a = profile.addresses;
  const o = profile.offsets;
  const nameLen = o.nameLength ?? GB_NAME_LENGTH;
  const partySize = o.partyMonSize ?? GEN1_PARTY_MON_SIZE;
  const boxSize = o.boxMonSize ?? GEN1_BOX_MON_SIZE;
  const battleSize = o.battleMonSize ?? GEN1_BATTLE_MON_SIZE;

  const partyList = () => readGbList(mem, { count: a.partyCount, species: a.partySpecies, mons: a.partyMons, ots: a.partyOTs, nicknames: a.partyNicknames }, 6, partySize, nameLen);
  const boxList = () => readGbList(mem, { count: a.boxCount, species: a.boxSpecies, mons: a.boxMons, ots: a.boxOTs, nicknames: a.boxNicknames }, o.boxCapacity ?? 20, boxSize, nameLen);
  const enemyList = () => readGbList(mem, { count: a.enemyPartyCount, species: a.enemyPartySpecies, mons: a.enemyMons, ots: a.enemyPartyOTs, nicknames: a.enemyPartyNicknames }, 6, partySize, nameLen);

  return {
    profile,
    read(opts = {}): GameState {
      const trainerName = decodeGen1String(mem.readBytes(a.playerName, nameLen));
      const trainerId = memBe16(mem, a.playerId);
      // The play-time counter runs from entering the overworld (new game or continue) until reset;
      // the title screen clears it and the main menu/Oak's intro never set it.
      const timer = (mem.read8(a.statusFlags6) >> (o.gameTimerBit ?? 0)) & 1;
      const partyEntries = partyList();
      const inGame = timer === 1 && trainerName.length > 0 && partyEntries !== undefined;
      const party = inGame ? decodeGen1List(partyEntries) : [];

      const mapId = mem.read8(a.curMap);
      const location = { ...gbLocation(profile, mapId), mapNum: mapId };
      const badgeBits = mem.read8(a.badges);
      const badges = Array.from({ length: 8 }, (_, i) => inGame && ((badgeBits >> i) & 1) === 1);

      const enemyRaw = mem.readBytes(a.enemyMon, battleSize);
      const enemyRes = decodeGen1BattleMon(enemyRaw);
      const enemyMon = enemyRes.ok ? enemyRes.mon : undefined;

      const mode = mem.read8(a.isInBattle);
      const battleType = mem.read8(a.battleType);
      const linked = mem.read8(a.linkState) !== 0;
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
      const ownedMatch = () => {
        if (!enemyMon) return false;
        const dvs = gen1Dvs(enemyRaw, true);
        const candidates = [...(partyEntries ?? []), ...(boxList() ?? [])];
        return candidates.some((e) => e.raw[0] === enemyRaw[0] && gen1Dvs(e.raw) === dvs && ((e.raw[0x0c] << 8) | e.raw[0x0d]) === trainerId);
      };
      const partyDown = party.length > 0 && party.every((s) => s.mon && s.mon.hp === 0);
      let result: BattleResult = 'none';
      if (mode === 0xff || partyDown) result = 'lost';
      else if (outcome === 1) result = 'lost';
      else if (outcome === 2) result = ownedMatch() ? 'caught' : 'ran';
      else if (outcome === 0 && enemyMon) result = enemyMon.hp! > 0 ? 'fled' : 'won';
      battle.result = inGame ? result : 'none';

      if (active) {
        const curOpp = mem.read8(a.curOpponent);
        if (linked) battle.kind = 'other';
        else if (mode === TRAINER_BATTLE) battle.kind = 'trainer';
        else battle.kind = battleType === (o.battleTypeOldMan ?? 1) ? 'other' : 'wild';

        let onField: { species: number; level: number } | undefined;
        if (mode === TRAINER_BATTLE) {
          const cls = mem.read8(a.trainerClass) || (curOpp >= OPP_ID_OFFSET ? curOpp - OPP_ID_OFFSET : 0);
          if (!linked) battle.trainerId = (cls << 8) | mem.read8(a.trainerNo);
          const entries = enemyList();
          battle.enemy = decodeGen1List(entries).flatMap((s) => (s.mon ? [s.mon] : []));
          // wEnemyMon is only the current battler once it matches its OT party slot (it holds the
          // previous battle's Pokémon until the first send-out).
          const pos = mem.read8(a.enemyMonPartyPos);
          const slot = entries?.[pos];
          if (enemyMon && slot && slot.raw[0] === enemyRaw[0] && slot.raw[0x21] === enemyMon.level && gen1Dvs(slot.raw) === gen1Dvs(enemyRaw, true)) {
            onField = { species: enemyMon.species, level: enemyMon.level };
          }
        } else if (enemyMon && enemyRaw[0] === mem.read8(a.enemyMonSpecies2) && enemyMon.level === mem.read8(a.curEnemyLevel)) {
          // Wild: wEnemyMonSpecies2 / wCurEnemyLevel are set before the battle starts (random encounter
          // or scripted wCurOpponent); wEnemyMon is valid once it agrees with them.
          battle.enemy = [enemyMon];
          onField = { species: enemyMon.species, level: enemyMon.level };
        }
        battle.enemyActive = onField ? [onField] : [];
        const slot = mem.read8(a.playerMonNumber);
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
        const box = mem.read8(a.currentBox) & 0x7f;
        state.boxes = decodeGen1List(boxList()).flatMap((s) => (s.mon ? [{ box, slot: s.slot, mon: s.mon as PokemonData }] : []));
      }
      return state;
    },
  };
}
