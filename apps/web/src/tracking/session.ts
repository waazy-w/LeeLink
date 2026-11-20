import type { EmulatorCore } from '../emulator/types';
import type { GameProfile, GameState, ProfileReader } from '@leelink/shared/profiles/types';
import { createProfileReader } from '@leelink/shared/profiles/engines';
import { EventDetector } from '@leelink/shared/tracking/detector';
import type { TrackerEvent } from '@leelink/shared/tracking/events';
import type { PartyMember } from '@leelink/shared/engine/types';
import type { PokemonData } from '@leelink/shared/model';

export interface TrackerCallbacks {
  onEvents(events: TrackerEvent[]): void;
  /** Party composition/levels changed (rate-limited by the caller's needs). */
  onParty(members: PartyMember[]): void;
  onState?(state: GameState): void;
}

/** Samples game memory on a frame cadence and turns it into tracker events. */
export class TrackerSession {
  readonly reader?: ProfileReader;
  private detector?: EventDetector;
  private lastPartyKey = '';
  private sampleEvery = 15; // 4 Hz at 60 fps
  private boxesEvery = 240; // every ~4 s
  lastState?: GameState;
  errors = 0;

  constructor(readonly core: EmulatorCore, readonly profile: GameProfile | undefined, private readonly cb: TrackerCallbacks) {
    if (profile) {
      this.reader = createProfileReader(profile, core.memory);
      if (this.reader) this.detector = new EventDetector(profile);
    }
  }

  get automatic() {
    return !!this.reader;
  }

  /** Tell the detector which Pokémon the run already knows about, so they aren't "new". */
  seed(mons: PokemonData[], fainted: Set<string>) {
    if (mons.length) this.detector?.seed(mons, fainted);
  }

  onFrame(frame: number) {
    if (!this.reader || frame % this.sampleEvery !== 0) return;
    let state: GameState;
    try {
      state = this.reader.read({ boxes: frame % this.boxesEvery === 0, frame });
    } catch (err) {
      // A bad profile or a read during a reset shouldn't crash the emulator loop.
      if (this.errors++ < 5) console.warn('tracker read failed', err);
      return;
    }
    this.lastState = state;
    this.cb.onState?.(state);
    const events = this.detector!.push(state);
    if (events.length) this.cb.onEvents(events);
    if (state.inGame) {
      const members = state.party.filter((s) => s.mon && !s.mon.isEgg).map((s) => ({
        uid: s.mon!.uid, species: s.mon!.species, level: s.mon!.level, nickname: s.mon!.nickname, hp: s.mon!.hp,
      }));
      // Only composition and levels go in the log; HP changes travel via presence.
      const key = members.map((m) => `${m.uid}:${m.species}:${m.level}`).join('|');
      if (key !== this.lastPartyKey && !state.party.some((s) => s.error)) {
        this.lastPartyKey = key;
        this.cb.onParty(members);
      }
    }
  }
}
