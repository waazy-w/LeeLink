/**
 * Turns a stream of GameState samples into TrackerEvents.
 *
 * Deterministic and side-effect free apart from its own memory of the previous samples, so
 * recorded snapshot sequences replay to identical events in tests.
 *
 * Robustness rules:
 *  - samples outside gameplay (title, intro) are ignored;
 *  - slots that fail to decode (caught mid-write) are treated as "unknown", never as changes;
 *  - a faint must be seen on two consecutive samples before it's reported;
 *  - battle outcome bytes are only trusted on the in-battle -> out-of-battle transition,
 *    because games leave the last outcome in memory afterwards.
 */
import type { PokemonData } from '../model';
import type { GameProfile, GameState } from '../profiles/types';
import { monRef, type DeathCause, type PlaceRef, type TrackerEvent } from './events';

interface KnownMon {
  mon: PokemonData;
  fainted: boolean;
  /** Consecutive samples with HP 0 while not yet marked fainted. */
  zeroSamples: number;
}

interface BattleContext {
  kind: GameState['battle']['kind'];
  place: PlaceRef;
  trainerId?: number;
  encounter?: { species: number; level: number; uid: string };
  encounterEmitted: boolean;
  lastCause: DeathCause;
  /** Lowest HP seen per party uid during this battle. */
  lowest: Map<string, { hp: number; maxHp: number }>;
}

export interface DetectorOptions {
  /** Samples of HP 0 required before a faint is reported. */
  faintConfirmSamples?: number;
  /** Samples after a "caught" battle end during which a new Pokémon counts as that catch. */
  catchWindowSamples?: number;
}

export class EventDetector {
  private known = new Map<string, KnownMon>();
  private seeded = false;
  private place?: PlaceRef;
  private badges: boolean[] = [];
  private battle?: BattleContext;
  private recentCatch?: { place: PlaceRef; species: number; samplesLeft: number };
  /** Engines without an outcome byte: wait to see whether the wild Pokémon joins the player. */
  private unresolved?: { place: PlaceRef; species: number; level: number; uid: string; samplesLeft: number };
  private wipedOut = false;
  private readonly faintConfirm: number;
  private readonly catchWindow: number;

  constructor(private readonly profile: GameProfile, opts: DetectorOptions = {}) {
    this.faintConfirm = opts.faintConfirmSamples ?? 2;
    this.catchWindow = opts.catchWindowSamples ?? 40;
  }

  /** uids already owned when tracking starts (e.g. restored from the run log). */
  seed(mons: PokemonData[], fainted: Set<string> = new Set()) {
    for (const mon of mons) this.known.set(mon.uid, { mon, fainted: fainted.has(mon.uid), zeroSamples: 0 });
    this.seeded = true;
  }

  push(state: GameState): TrackerEvent[] {
    if (!state.inGame) return [];
    const events: TrackerEvent[] = [];
    const place: PlaceRef = { id: state.location.id, name: state.location.name, area: state.location.area };

    const owned = this.ownedMons(state);
    if (!this.seeded) {
      // First sample of a session: everything already owned is pre-existing, not new.
      this.seed(owned.map((o) => o.mon), new Set(owned.filter((o) => o.mon.hp === 0).map((o) => o.mon.uid)));
      if (state.trainer) events.push({ type: 'session', trainer: state.trainer });
      this.place = place;
      this.badges = state.badges.slice();
      return events;
    }

    // ---- location
    if (place.area && (!this.place || this.place.area !== place.area || this.place.id !== place.id)) {
      // During battle transitions some games briefly report stale map headers; only follow
      // location changes while out of battle.
      if (!state.battle.active) {
        events.push({ type: 'location', place, from: this.place });
        this.place = place;
      }
    }
    const here = this.place ?? place;

    // ---- battles
    if (state.battle.active && !this.battle) {
      this.battle = {
        kind: state.battle.kind,
        place: here,
        trainerId: state.battle.trainerId,
        encounterEmitted: false,
        lowest: new Map(),
        lastCause: { kind: state.battle.kind === 'trainer' ? 'trainer' : state.battle.kind === 'wild' ? 'wild' : 'other' },
      };
    }
    if (this.battle && state.battle.active) {
      const b = this.battle;
      for (const slot of state.party) {
        const m = slot.mon;
        if (!m || m.hp === undefined || !m.maxHp) continue;
        const prev = b.lowest.get(m.uid);
        if (!prev || m.hp < prev.hp) b.lowest.set(m.uid, { hp: m.hp, maxHp: m.maxHp });
      }
      if (b.kind === 'wild' && !b.encounterEmitted && state.battle.enemy.length) {
        const e = state.battle.enemy[0];
        b.encounter = { species: e.species, level: e.level, uid: e.uid };
        b.encounterEmitted = true;
        events.push({ type: 'encounter', place: b.place, species: e.species, level: e.level, shiny: e.shiny || undefined });
      }
      const foe = state.battle.enemyActive?.[0];
      if (foe) {
        b.lastCause = {
          kind: b.kind === 'trainer' ? 'trainer' : 'wild',
          trainerId: b.trainerId,
          trainerName: b.trainerId !== undefined ? this.profile.trainers?.[b.trainerId]?.name : undefined,
          enemySpecies: foe.species,
          enemyLevel: foe.level,
        };
      }
    }

    const cause = this.battle?.lastCause ?? { kind: 'other' as const };

    // ---- battle end (outcome only trusted on this transition)
    if (this.battle && !state.battle.active) {
      const b = this.battle;
      const result = state.battle.result;
      for (const [uid, low] of b.lowest) {
        const now = state.party.find((x) => x.mon?.uid === uid)?.mon;
        if (now && (now.hp ?? 0) > 0 && low.hp > 0 && low.hp <= Math.max(1, Math.floor(low.maxHp * 0.1))) {
          events.push({ type: 'close-call', place: b.place, mon: monRef(now), hp: low.hp, maxHp: low.maxHp, cause: b.lastCause });
        }
      }
      if (b.kind === 'wild' && b.encounter && result === 'none') {
        this.unresolved = { place: b.place, ...b.encounter, samplesLeft: this.catchWindow };
      } else if (b.kind === 'wild' && b.encounter) {
        events.push({ type: 'encounter-end', place: b.place, species: b.encounter.species, level: b.encounter.level, result });
        if (result === 'caught') this.recentCatch = { place: b.place, species: b.encounter.species, samplesLeft: this.catchWindow };
      } else if (b.kind === 'trainer' && b.trainerId !== undefined) {
        events.push({ type: 'trainer-battle', place: b.place, trainerId: b.trainerId, trainerName: this.profile.trainers?.[b.trainerId]?.name, result });
      }
      this.battle = undefined;
    }
    if (this.unresolved) {
      const u = this.unresolved;
      const joined = owned.some((o) => o.mon.uid === u.uid);
      if (joined || --u.samplesLeft <= 0) {
        events.push({ type: 'encounter-end', place: u.place, species: u.species, level: u.level, result: joined ? 'caught' : 'other' });
        if (joined) this.recentCatch = { place: u.place, species: u.species, samplesLeft: this.catchWindow };
        this.unresolved = undefined;
      }
    }

    // ---- party / boxes: faints, revives, evolutions, new Pokémon
    for (const { mon, inParty } of owned) {
      const k = this.known.get(mon.uid);
      if (!k) {
        const c = this.recentCatch;
        const caught = !!c && c.species === mon.species;
        events.push({ type: 'obtained', place: caught ? c.place : here, mon, method: caught ? 'caught' : 'gift' });
        if (caught) this.recentCatch = undefined;
        this.known.set(mon.uid, { mon, fainted: false, zeroSamples: 0 });
        continue;
      }
      if (k.mon.species !== mon.species && !mon.isEgg && !k.mon.isEgg) {
        events.push({ type: 'evolved', mon: monRef(mon), fromSpecies: k.mon.species });
      }
      if (inParty && mon.hp !== undefined) {
        if (mon.hp === 0 && !k.fainted) {
          k.zeroSamples++;
          if (k.zeroSamples >= this.faintConfirm) {
            k.fainted = true;
            events.push({ type: 'faint', place: here, mon: monRef(mon), cause });
          }
        } else if (mon.hp > 0) {
          k.zeroSamples = 0;
          if (k.fainted) {
            k.fainted = false;
            events.push({ type: 'revived', mon: monRef(mon) });
          }
        }
      }
      k.mon = mon;
    }

    // ---- whiteout: every readable party member at 0 HP
    const party = state.party.filter((s) => s.mon && !s.mon.isEgg).map((s) => s.mon!);
    const allDown = party.length > 0 && party.every((m) => m.hp === 0 && this.known.get(m.uid)?.fainted);
    if (allDown && !this.wipedOut) {
      this.wipedOut = true;
      events.push({ type: 'whiteout', place: here });
    } else if (!allDown && party.some((m) => (m.hp ?? 0) > 0)) {
      this.wipedOut = false;
    }

    if (this.recentCatch && --this.recentCatch.samplesLeft <= 0) this.recentCatch = undefined;

    // ---- badges
    state.badges.forEach((has, i) => {
      if (has && !this.badges[i]) events.push({ type: 'badge', index: i, count: state.badges.filter(Boolean).length });
    });
    this.badges = state.badges.slice();

    return events;
  }

  private ownedMons(state: GameState): { mon: PokemonData; inParty: boolean }[] {
    const out: { mon: PokemonData; inParty: boolean }[] = [];
    for (const s of state.party) if (s.mon && !s.mon.isEgg) out.push({ mon: s.mon, inParty: true });
    for (const b of state.boxes ?? []) if (!b.mon.isEgg) out.push({ mon: b.mon, inParty: false });
    return out;
  }
}
