/**
 * Gen 4/5 (DS) reader — EXPERIMENTAL.
 *
 * DS games keep the party in a heap block that moves between boots, so instead of fixed addresses
 * this reader finds `struct Party { u32 capacity (=6); u32 count; Pokemon mons[6] }` in main RAM:
 *  1. if the profile gives `addresses.basePtr` + `offsets.party`, try that first;
 *  2. otherwise scan for the capacity/count signature and keep candidates whose first Pokémon
 *     passes the checksum.
 * The player's party is the candidate that already existed outside battle; any new Party struct
 * that appears while that one is stable is treated as the opponent (wild encounter / trainer).
 * A wild Pokémon keeps its personality when caught, so catches are matched to encounters by uid.
 *
 * Map/badge/battle-outcome addresses aren't verified for DS games yet, so location comes from the
 * player (manual "I'm at" button) and the detector infers results from party changes.
 */
import type { MemoryReader } from '../memory/reader';
import type { PokemonData, PartySlot } from '../model';
import type { GameProfile, GameState, ProfileReader } from '../profiles/types';
import { decodeNdsPokemon, GEN4_DECODE, type NdsDecodeOptions } from './pokemon';
import { GEN5_DECODE } from '../gen5/pokemon';

const MAIN_START = 0x02000000;
const MAIN_SIZE = 0x400000;

interface Options {
  decode: NdsDecodeOptions;
}

function factory({ decode }: Options) {
  const size = decode.partySize;
  return (profile: GameProfile, mem: MemoryReader): ProfileReader => {
    let playerParty: number | undefined;
    let enemyParty: number | undefined;
    let sample = 0;

    const readParty = (addr: number): PartySlot[] | undefined => {
      if (mem.read32(addr) !== 6) return undefined;
      const count = mem.read32(addr + 4);
      if (count < 1 || count > 6) return undefined;
      const bytes = mem.readBytes(addr + 8, count * size);
      const slots: PartySlot[] = [];
      for (let i = 0; i < count; i++) {
        const r = decodeNdsPokemon(bytes.subarray(i * size, (i + 1) * size), decode);
        slots.push(r.ok ? { slot: i, mon: r.mon } : { slot: i, error: r.reason });
      }
      // A real party has a valid first slot with a sane level.
      const first = slots[0].mon;
      return first && first.level >= 1 && first.level <= 100 ? slots : undefined;
    };

    /** Signature scan of main RAM (≈1M aligned words; only done when needed). */
    const scan = (): number[] => {
      const out: number[] = [];
      const ram = mem.readBytes(MAIN_START, MAIN_SIZE);
      const dv = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
      for (let o = 0; o + 8 + size <= ram.length; o += 4) {
        if (dv.getUint32(o, true) !== 6) continue;
        const c = dv.getUint32(o + 4, true);
        if (c < 1 || c > 6) continue;
        if (readParty(MAIN_START + o)) out.push(MAIN_START + o);
      }
      return out;
    };

    const fromProfile = (): number | undefined => {
      const base = profile.addresses.basePtr;
      const off = profile.offsets.party;
      if (base === undefined || off === undefined) return undefined;
      const p = mem.read32(base);
      if (p < MAIN_START || p >= MAIN_START + MAIN_SIZE) return undefined;
      return readParty(p + off) ? p + off : undefined;
    };

    return {
      profile,
      read(opts = {}): GameState {
        sample++;
        let party = playerParty !== undefined ? readParty(playerParty) : undefined;
        if (!party) {
          playerParty = fromProfile();
          if (playerParty === undefined && sample % 4 === 1) {
            const found = scan();
            // Prefer the lowest address: the save-data block is allocated before battle structures.
            playerParty = found[0];
          }
          party = playerParty !== undefined ? readParty(playerParty) : undefined;
        }

        // Opponent: another Party struct whose Pokémon aren't ours (re-scanned about once a second).
        let enemy: PokemonData[] = [];
        if (party && sample % 4 === 0) {
          const ours = new Set(party.map((s) => s.mon?.uid));
          const others = scan().filter((a) => a !== playerParty);
          enemyParty = others.find((a) => readParty(a)!.some((s) => s.mon && !ours.has(s.mon.uid)));
        }
        if (party && enemyParty !== undefined) {
          const e = readParty(enemyParty);
          const ours = new Set(party.map((s) => s.mon?.uid));
          if (e && e.some((s) => s.mon && !ours.has(s.mon.uid))) enemy = e.filter((s) => s.mon).map((s) => s.mon!);
          else enemyParty = undefined;
        }

        const active = enemy.length > 0;
        // Wild Pokémon are generated with the player's trainer id; trainers' Pokémon aren't.
        const ots = new Map<number, number>();
        for (const sl of party ?? []) if (sl.mon) ots.set(sl.mon.otId, (ots.get(sl.mon.otId) ?? 0) + 1);
        const playerOt = [...ots.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
        return {
          inGame: !!party,
          frame: opts.frame ?? 0,
          party: party ?? [],
          // Location isn't read for DS yet: an empty area tells the engine to use the player's
          // manually set location.
          location: { id: 0, name: '', area: '' },
          badges: [],
          battle: {
            active,
            kind: active ? (enemy.length <= 2 && enemy[0].otId === playerOt ? 'wild' : 'trainer') : 'none',
            enemy,
            outcome: 0,
            result: 'none',
            activeSlots: active ? [0] : [],
            enemyActive: enemy[0] ? [{ species: enemy[0].species, level: enemy[0].level }] : undefined,
            flags: 0,
          },
        };
      },
    };
  };
}

export const createGen4Reader = factory({ decode: GEN4_DECODE });
export const createGen5Reader = factory({ decode: GEN5_DECODE });
