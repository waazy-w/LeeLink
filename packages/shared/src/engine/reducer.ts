/**
 * The Soul Link rules engine.
 *
 * `buildRunState(log)` is a pure function: the same log always yields the same state.
 * Undo, disputes and settings changes are just more log entries, so any mistake can be
 * reverted and the whole run rebuilt from scratch at any time.
 */
import { species as speciesInfo, speciesName, typesFor } from '../data/species';
import type { DeathCause, TrackerEvent } from '../tracking/events';
import { PRESETS, type RuleSettings } from './settings';
import type {
  Alert, AreaEncounter, Dispute, FeedItem, GameInfo, Link, LogEntry, MonStatus, PartyMember, PlayerAction,
  PlayerId, PlayerState, RunMon, RunState, Warning,
} from './types';

export const STARTER_AREA = 'Starter';

// ---------------------------------------------------------------------------------------------
// Voiding: undo entries and accepted disputes

/** Seqs voided by undo (an undo can itself be undone, restoring its target). */
function undoVoids(log: LogEntry[]): Set<number> {
  const voided = new Set<number>();
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === 'undo' && !voided.has(e.seq)) voided.add(e.target);
  }
  return voided;
}

function resolveDisputes(log: LogEntry[], voided: Set<number>, quorum: (entrySeq: number) => RuleSettings['disputeQuorum']) {
  const players = new Set<PlayerId>();
  const disputes: Record<string, Dispute> = {};
  for (const e of log) {
    if (voided.has(e.seq)) continue;
    if (e.kind === 'player-join') players.add(e.playerId);
    if (e.kind === 'dispute-open' && !disputes[e.disputeId]) {
      disputes[e.disputeId] = { id: e.disputeId, target: e.target, reason: e.reason, openedBy: e.playerId, votes: { [e.playerId]: true }, status: 'open', seq: e.seq };
    }
    if (e.kind === 'dispute-vote') {
      const d = disputes[e.disputeId];
      if (d && d.status === 'open') d.votes[e.playerId] = e.approve;
    }
    if (e.kind === 'dispute-open' || e.kind === 'dispute-vote') {
      const d = disputes[e.disputeId];
      if (!d || d.status !== 'open') continue;
      const n = players.size || 1;
      const yes = Object.values(d.votes).filter(Boolean).length;
      const no = Object.values(d.votes).filter((v) => !v).length;
      const need = quorum(e.seq) === 'unanimous' ? n : Math.floor(n / 2) + 1;
      if (yes >= need) d.status = 'accepted';
      else if (no > n - need) d.status = 'rejected';
    }
  }
  for (const d of Object.values(disputes)) if (d.status === 'accepted') voided.add(d.target);
  return disputes;
}

// ---------------------------------------------------------------------------------------------

export function emptyRunState(settings: RuleSettings = PRESETS.classic): RunState {
  return {
    settings,
    levelCaps: [],
    game: { generation: 3 },
    players: {},
    mons: {},
    links: {},
    areaOrder: [],
    warnings: [],
    alerts: [],
    feed: [],
    disputes: {},
    voided: [],
    reviveShards: { earned: 0, used: 0 },
    status: 'active',
    lastSeq: 0,
  };
}

class Reducer {
  s: RunState;
  private seq = 0;
  private at = 0;
  private playerId?: PlayerId;
  /** Last warning keys emitted per player, to avoid repeating the same warning every update. */
  private activeWarnings = new Map<PlayerId, Set<string>>();
  private orphanCounter = 0;

  constructor(initial: RuleSettings) {
    this.s = emptyRunState(initial);
  }

  // ---- helpers
  private player(id: PlayerId): PlayerState {
    let p = this.s.players[id];
    if (!p) {
      p = { id, name: id, badges: 0, party: [], encounters: {}, retryUsed: 0, wipes: 0, hadFirstEncounter: false };
      this.s.players[id] = p;
    }
    return p;
  }
  private get playerIds() {
    return Object.keys(this.s.players);
  }
  private name(id: PlayerId) {
    return this.s.players[id]?.name ?? id;
  }
  private monLabel(m: { nickname?: string; species: number }) {
    const sp = speciesName(m.species);
    return m.nickname && m.nickname.toUpperCase() !== sp.toUpperCase() ? `${m.nickname} (${sp})` : sp;
  }
  private feed(kind: FeedItem['kind'], text: string, playerId = this.playerId) {
    this.s.feed.push({ seq: this.seq, at: this.at, playerId, kind, text });
  }
  private alert(kind: Alert['kind'], message: string, players: PlayerId[] = [], linkId?: string) {
    this.s.alerts.push({ seq: this.seq, at: this.at, kind, message, players, linkId });
  }
  private warn(playerId: PlayerId, code: Warning['code'], message: string, preCatch = false) {
    this.s.warnings.push({ seq: this.seq, at: this.at, playerId, code, message, preCatch: preCatch || undefined });
    this.feed('warning', `${this.name(playerId)}: ${message}`, playerId);
  }
  private primaryType(speciesId: number): string | undefined {
    const o = this.s.game.typeOverrides?.[speciesId];
    return (o ?? typesFor(speciesId, this.s.game.generation))[0];
  }
  private family(speciesId: number) {
    return speciesInfo(speciesId)?.family ?? -speciesId;
  }
  private retryTokensLeft(p: PlayerState) {
    return Math.max(0, this.s.settings.retryTokens - p.retryUsed);
  }

  // ---- entry point
  apply(e: LogEntry) {
    this.seq = e.seq;
    this.at = e.at;
    this.s.lastSeq = e.seq;
    this.playerId = 'playerId' in e ? e.playerId : undefined;
    switch (e.kind) {
      case 'player-join': {
        const p = this.player(e.playerId);
        p.name = e.name;
        this.feed('info', `${e.name} joined the run`);
        break;
      }
      case 'settings':
        this.s.settings = e.settings;
        if (e.levelCaps) this.s.levelCaps = e.levelCaps;
        if (e.game) this.s.game = e.game;
        this.updateShards();
        break;
      case 'tracker':
        this.tracker(e.playerId, e.event);
        break;
      case 'action':
        this.action(e.playerId, e.action);
        break;
      case 'undo':
        this.feed('undo', `${this.name(e.playerId)} undid an event`);
        break;
      case 'dispute-open':
        this.feed('dispute', `${this.name(e.playerId)} disputed an event: ${e.reason}`);
        break;
      case 'dispute-vote':
        break;
    }
  }

  // ---- tracker events
  private tracker(pid: PlayerId, ev: TrackerEvent) {
    const p = this.player(pid);
    // Engines that can't read the map (DS, for now) send an empty area: use the player's
    // manually set location instead.
    if ('place' in ev && ev.place && !ev.place.area) {
      const area = p.location ?? 'Unknown area';
      ev = { ...ev, place: { ...ev.place, name: area, area } } as TrackerEvent;
    }
    switch (ev.type) {
      case 'session':
        p.trainer = ev.trainer;
        break;
      case 'location':
        p.location = ev.place.area;
        break;
      case 'encounter':
        p.location = ev.place.area;
        this.encounter(p, ev.place.area, ev.species, ev.level, ev.shiny);
        break;
      case 'encounter-end': {
        const enc = p.encounters[ev.place.area];
        if (!enc || enc.status !== 'pending' || enc.species !== ev.species) break;
        if (ev.result === 'caught') {
          // The Pokémon itself arrives with the 'obtained' event; keep the slot reserved.
          enc.status = 'caught';
        } else {
          enc.status = 'failed';
          this.feed('fail', `${p.name} failed the ${ev.place.area} encounter (${speciesName(ev.species)}, ${ev.result})`);
          this.resolveArea(ev.place.area);
        }
        break;
      }
      case 'obtained':
        this.obtained(p, ev.place.area, { uid: ev.mon.uid, species: ev.mon.species, level: ev.mon.level, nickname: ev.mon.nickname }, ev.method);
        break;
      case 'faint':
        this.faint(p, ev.mon.uid, ev.cause, ev.place.area, ev.mon.level);
        break;
      case 'revived':
        break;
      case 'evolved': {
        const m = this.s.mons[ev.mon.uid];
        if (m) {
          this.feed('info', `${p.name}'s ${this.monLabel(m)} evolved into ${speciesName(ev.mon.species)}`);
          m.species = ev.mon.species;
          m.level = ev.mon.level;
        }
        break;
      }
      case 'badge':
        this.badge(p, ev.count);
        break;
      case 'trainer-battle':
        if (ev.result === 'won' && ev.trainerName) this.feed('info', `${p.name} beat ${ev.trainerName}`);
        break;
      case 'whiteout':
        this.whiteout(p, ev.place.area);
        break;
      case 'close-call': {
        const m = this.s.mons[ev.mon.uid];
        if (m) this.feed('info', `Close call! ${p.name}'s ${this.monLabel(m)} survived on ${ev.hp}/${ev.maxHp} HP`);
        break;
      }
    }
  }

  // ---- player actions
  private action(pid: PlayerId, a: PlayerAction) {
    const p = this.player(pid);
    switch (a.type) {
      case 'manual-encounter': {
        this.encounter(p, a.area, a.species, a.level ?? 0);
        const enc = p.encounters[a.area];
        if (a.result === 'failed') {
          if (enc?.status === 'pending' && enc.species === a.species) {
            enc.status = 'failed';
            this.feed('fail', `${p.name} failed the ${a.area} encounter (${speciesName(a.species)})`);
            this.resolveArea(a.area);
          }
        } else {
          if (enc?.status === 'pending' && enc.species === a.species) enc.status = 'caught';
          this.obtained(p, a.area, { uid: `manual:${pid}:${this.seq}`, species: a.species, level: a.level ?? 0, nickname: a.nickname ?? '' }, 'manual');
        }
        break;
      }
      case 'manual-death':
        this.faint(p, a.uid, a.cause ?? { kind: 'other' }, p.location, this.s.mons[a.uid]?.level ?? 0);
        break;
      case 'manual-badge':
        this.badge(p, a.count);
        break;
      case 'manual-location':
        p.location = a.area;
        break;
      case 'party':
        p.party = a.members;
        for (const m of a.members) {
          const mon = this.s.mons[m.uid];
          if (mon && mon.owner === pid) {
            mon.level = m.level;
            if (m.species && m.species !== mon.species) mon.species = m.species;
          }
        }
        this.checkParties();
        break;
      case 'use-retry': {
        const enc = p.encounters[a.area];
        if (this.s.settings.failedEncounter !== 'retry-token' || !enc || enc.status !== 'failed' || this.retryTokensLeft(p) <= 0) break;
        p.retryUsed++;
        delete p.encounters[a.area];
        const link = this.linkForArea(a.area);
        if (link) {
          delete link.members[pid];
          if (link.status === 'failed') {
            link.status = 'pending';
            for (const uid of Object.values(link.members)) if (uid && this.s.mons[uid]?.status === 'link-failed') this.s.mons[uid].status = 'pending';
          }
        }
        this.feed('info', `${p.name} used a retry token on ${a.area} (${this.retryTokensLeft(p)} left)`);
        break;
      }
      case 'use-revive': {
        const link = this.s.links[a.linkId];
        const sh = this.s.reviveShards;
        if (!this.s.settings.reviveShards.enabled || !link || link.status !== 'dead' || sh.earned - sh.used <= 0) break;
        sh.used++;
        link.status = 'alive';
        link.revived = true;
        for (const uid of Object.values(link.members)) {
          const m = uid ? this.s.mons[uid] : undefined;
          if (m) {
            m.status = 'alive';
            m.death = undefined;
          }
        }
        this.alert('link-formed', `${p.name} used a revive shard on the ${link.area} link`, [], link.id);
        this.feed('link', `Revive shard used on ${link.area} (${sh.earned - sh.used} left)`);
        break;
      }
      case 'finish-run':
        this.s.status = a.result;
        this.alert('run-over', a.result === 'won' ? 'Run complete! Hall of fame.' : 'Run abandoned.');
        break;
    }
  }

  // ---- rules
  private familyOwned(pid: PlayerId, speciesId: number) {
    const fam = this.family(speciesId);
    return Object.values(this.s.mons).some(
      (m) => m.status !== 'extra' && (this.s.settings.dupesScope === 'run' || m.owner === pid) && this.family(m.species) === fam,
    );
  }

  private encounter(p: PlayerState, area: string, speciesId: number, level: number, shiny?: boolean) {
    if (p.encounters[area]) return; // not the first encounter here; only matters if they catch it
    const { settings } = this.s;
    if (settings.shinyClause && shiny) {
      this.warn(p.id, 'shiny', `Shiny ${speciesName(speciesId)} on ${area}: shiny clause — catch it freely, it doesn't use the encounter.`, true);
      return;
    }
    if (settings.dupesClause && this.familyOwned(p.id, speciesId)) {
      this.warn(p.id, 'dupe', `${speciesName(speciesId)} on ${area} is a dupe — it doesn't count, the next encounter here will.`, true);
      return;
    }
    p.encounters[area] = { species: speciesId, level, status: 'pending', seq: this.seq };
    p.hadFirstEncounter = true;
    if (!this.s.areaOrder.includes(area)) this.s.areaOrder.push(area);

    if (settings.typeClause) {
      const t = this.primaryType(speciesId);
      const clash = Object.values(this.s.links).find(
        (l) => l.status === 'alive' && Object.values(l.members).some((uid) => uid && this.primaryType(this.s.mons[uid]?.species ?? 0) === t),
      );
      if (t && clash) {
        this.warn(p.id, 'type-clause', `Catching ${speciesName(speciesId)} adds a ${t}-type link; the ${clash.area} link is already ${t} — they can't be on the team together.`, true);
      }
    }
  }

  private obtained(p: PlayerState, placeArea: string, m: { uid: string; species: number; level: number; nickname: string }, method: 'caught' | 'gift' | 'manual') {
    if (this.s.mons[m.uid]) return;
    const firstMon = !Object.values(this.s.mons).some((x) => x.owner === p.id);
    let area = placeArea;
    let counts = true;
    if (method === 'gift') {
      if (firstMon) area = STARTER_AREA;
      else counts = this.s.settings.giftsAreEncounters;
    }
    const mon: RunMon = {
      uid: m.uid, owner: p.id, species: m.species, nickname: m.nickname, level: m.level, area,
      origin: method === 'manual' ? 'manual' : method, status: 'extra', obtainedSeq: this.seq,
    };
    this.s.mons[m.uid] = mon;
    if (!counts) {
      this.feed('catch', `${p.name} received ${this.monLabel(mon)} (gift, not linked)`);
      return;
    }

    let enc = p.encounters[area];
    if (!enc) {
      // No encounter seen (gift, starter, or tracker missed the battle start): this is the encounter.
      if (this.s.settings.dupesClause && method !== 'gift' && this.familyOwned(p.id, m.species) && !firstMon) {
        mon.status = 'extra';
        this.warn(p.id, 'dupe', `${this.monLabel(mon)} is a dupe and doesn't count for ${area}.`);
        return;
      }
      enc = { species: m.species, level: m.level, status: 'caught', seq: this.seq };
      p.encounters[area] = enc;
      if (area !== STARTER_AREA) p.hadFirstEncounter = true;
      if (!this.s.areaOrder.includes(area)) this.s.areaOrder.push(area);
    } else if (enc.uid || enc.status === 'failed' || enc.status === 'skipped' || (enc.species !== m.species && enc.status !== 'caught')) {
      mon.status = 'extra';
      this.warn(p.id, 'second-catch', `${this.monLabel(mon)}: ${area} encounter was already used — this catch isn't part of the run.`);
      return;
    }
    enc.status = 'caught';
    enc.uid = m.uid;
    mon.status = 'pending';
    this.feed('catch', mon.origin === 'gift' ? `${p.name} received ${this.monLabel(mon)}${area === STARTER_AREA ? ' as their starter' : ` (${area})`}` : `${p.name} caught ${this.monLabel(mon)} on ${area}`);
    this.resolveArea(area);
  }

  private linkForArea(area: string): Link | undefined {
    return Object.values(this.s.links).find((l) => l.area === area && !l.id.startsWith('orphan-'));
  }

  private resolveArea(area: string) {
    let link = this.linkForArea(area);
    if (!link) {
      link = { id: `link:${area}`, area, members: {}, status: 'pending', createdSeq: this.seq };
      this.s.links[link.id] = link;
    }
    for (const pid of this.playerIds) {
      const enc = this.s.players[pid].encounters[area];
      if (enc?.status === 'failed') link.members[pid] = null;
      else if (enc?.uid) link.members[pid] = enc.uid;
    }
    for (const uid of Object.values(link.members)) {
      const m = uid ? this.s.mons[uid] : undefined;
      if (m) m.linkId = link.id;
    }
    if (link.status === 'dead') {
      // A partner already died while this link was pending: newcomers are dead on arrival.
      for (const uid of Object.values(link.members)) {
        const m = uid ? this.s.mons[uid] : undefined;
        if (m && m.status === 'pending') {
          m.status = 'link-dead';
          this.alert('link-death', `${this.monLabel(m)}'s partner on ${area} is already dead — box it.`, [m.owner], link.id);
        }
      }
      return;
    }
    const resolved = this.playerIds.filter((pid) => link!.members[pid] !== undefined);
    if (resolved.length < this.playerIds.length) return; // still waiting for partners

    const caught = this.playerIds.filter((pid) => link!.members[pid]);
    const failed = this.playerIds.filter((pid) => link!.members[pid] === null);
    const setAll = (status: MonStatus) => caught.forEach((pid) => (this.s.mons[link!.members[pid]!].status = status));

    if (!failed.length) {
      link.status = 'alive';
      setAll('alive');
      const names = caught.map((pid) => `${this.name(pid)}'s ${this.monLabel(this.s.mons[link!.members[pid]!])}`).join(' + ');
      this.alert('link-formed', `Linked on ${area}: ${names}`, [], link.id);
      this.feed('link', `New link on ${area}: ${names}`);
      return;
    }
    if (!caught.length) {
      link.status = 'failed';
      this.feed('link', `${area}: everyone failed — no link`);
      return;
    }
    switch (this.s.settings.failedEncounter) {
      case 'classic':
      case 'retry-token': {
        link.status = 'failed';
        setAll('link-failed');
        const who = failed.map((pid) => this.name(pid)).join(', ');
        const tokens = this.s.settings.failedEncounter === 'retry-token'
          ? ` ${failed.map((pid) => `${this.name(pid)} has ${this.retryTokensLeft(this.s.players[pid])} retry token(s).`).join(' ')}`
          : '';
        this.alert('link-failed', `${area}: ${who} failed the encounter, so the partner catch can't be used.${tokens}`, caught, link.id);
        this.feed('link', `${area} link failed (${who})`);
        break;
      }
      case 'orphan':
        link.status = 'orphaned';
        setAll('orphan');
        this.feed('link', `${area}: partner catch boxed as an orphan until a later link can adopt it`);
        this.adoptOrphans();
        break;
    }
  }

  /** Orphan mode: whenever every player has an orphan, the oldest ones form a new link. */
  private adoptOrphans() {
    for (;;) {
      const picks: Record<PlayerId, RunMon> = {};
      for (const pid of this.playerIds) {
        const o = Object.values(this.s.mons).filter((m) => m.owner === pid && m.status === 'orphan').sort((a, b) => a.obtainedSeq - b.obtainedSeq)[0];
        if (!o) return;
        picks[pid] = o;
      }
      const id = `orphan-${++this.orphanCounter}`;
      const areas = [...new Set(Object.values(picks).map((m) => m.area))].join(' + ');
      const link: Link = { id, area: areas, members: {}, status: 'alive', createdSeq: this.seq };
      for (const [pid, m] of Object.entries(picks)) {
        link.members[pid] = m.uid;
        m.status = 'alive';
        m.linkId = id;
      }
      this.s.links[id] = link;
      this.alert('link-formed', `Orphans adopted into a new link: ${Object.values(picks).map((m) => this.monLabel(m)).join(' + ')}`, [], id);
      this.feed('link', `Orphan link formed (${areas})`);
    }
  }

  private faint(p: PlayerState, uid: string, cause: DeathCause, place: string | undefined, level: number) {
    const m = this.s.mons[uid];
    if (!m || m.owner !== p.id || m.status === 'dead') return;
    if (this.s.settings.graceUntilFirstEncounter && !p.hadFirstEncounter) {
      this.feed('info', `${p.name}'s ${this.monLabel(m)} fainted before the first encounter — doesn't count`);
      return;
    }
    const wasUsable = m.status;
    m.status = 'dead';
    m.death = { seq: this.seq, at: this.at, place, cause, level: level || m.level };
    const by = cause.trainerName ?? (cause.enemySpecies ? `wild ${speciesName(cause.enemySpecies)}` : undefined);
    this.feed('death', `${p.name}'s ${this.monLabel(m)} died${by ? ` to ${by}${cause.enemyLevel ? ` (Lv${cause.enemyLevel})` : ''}` : ''}${place ? ` on ${place}` : ''}`);

    const link = m.linkId ? this.s.links[m.linkId] : undefined;
    if (!link || (link.status !== 'alive' && link.status !== 'pending') || wasUsable === 'extra') return;
    link.status = 'dead';
    const partners = Object.entries(link.members).filter(([pid, puid]) => pid !== p.id && puid);
    for (const [pid, puid] of partners) {
      const pm = this.s.mons[puid!];
      if (pm && pm.status !== 'dead') {
        pm.status = 'link-dead';
        this.alert('link-death', `${p.name}'s ${this.monLabel(m)} died — ${this.name(pid)}, box ${this.monLabel(pm)} now!`, [pid], link.id);
      }
    }
    if (!partners.length) this.alert('link-death', `${p.name}'s ${this.monLabel(m)} died. The ${link.area} link is dead.`, [], link.id);
    this.checkParties();
  }

  private whiteout(p: PlayerState, place: string) {
    if (this.s.settings.graceUntilFirstEncounter && !p.hadFirstEncounter) return;
    p.wipes++;
    if (this.s.settings.wipe === 'ends-run') {
      this.s.status = 'failed';
      this.alert('wipe', `${p.name} whited out on ${place}. The run is over.`);
      this.alert('run-over', 'Run over: wipe.');
      this.feed('wipe', `${p.name} whited out on ${place} — run over`);
    } else {
      this.alert('wipe', `${p.name} whited out on ${place}. Every link in their party is dead.`);
      this.feed('wipe', `${p.name} whited out on ${place}`);
      for (const pm of p.party) {
        const m = this.s.mons[pm.uid];
        if (m && m.status !== 'dead') this.faint(p, m.uid, { kind: 'other' }, place, m.level);
      }
    }
  }

  private badge(p: PlayerState, count: number) {
    if (count <= p.badges) return;
    const before = Math.min(...this.playerIds.map((id) => this.s.players[id].badges));
    p.badges = count;
    this.feed('badge', `${p.name} earned badge ${count}`);
    this.alert('badge', `${p.name} earned badge ${count}!`);
    const after = Math.min(...this.playerIds.map((id) => this.s.players[id].badges));
    for (const gate of this.s.settings.pacingGates) {
      if (before < gate && after >= gate) this.alert('gate-open', `Everyone has ${gate} badge${gate > 1 ? 's' : ''} — gate open, carry on!`);
    }
    this.updateShards();
  }

  private updateShards() {
    const rs = this.s.settings.reviveShards;
    if (!rs.enabled || !this.playerIds.length) {
      this.s.reviveShards.earned = 0;
      return;
    }
    const minBadges = Math.min(...this.playerIds.map((id) => this.s.players[id].badges));
    this.s.reviveShards.earned = Math.min(rs.max, Math.floor(minBadges * rs.perBadge));
  }

  /** Party legality: dead/unusable Pokémon, partners not on the team, type clause, level caps. */
  private checkParties() {
    const { settings, mons, links } = this.s;
    const partyUids = new Map<PlayerId, Set<string>>(this.playerIds.map((id) => [id, new Set(this.s.players[id].party.map((m) => m.uid))]));
    // Primary type -> links using it across the combined active teams.
    const typeLinks = new Map<string, Set<string>>();
    for (const pid of this.playerIds) {
      for (const pm of this.s.players[pid].party) {
        const m = mons[pm.uid];
        if (!m?.linkId || m.status !== 'alive') continue;
        const t = this.primaryType(m.species);
        if (!t) continue;
        if (!typeLinks.has(t)) typeLinks.set(t, new Set());
        typeLinks.get(t)!.add(m.linkId);
      }
    }
    for (const pid of this.playerIds) {
      const p = this.s.players[pid];
      const found: [string, Warning['code'], string][] = [];
      const cap = settings.levelCaps ? this.s.levelCaps.find((c) => c.badge === p.badges + 1)?.level : undefined;
      for (const pm of p.party) {
        const m = mons[pm.uid];
        if (!m) continue;
        const label = this.monLabel(m);
        if (m.status === 'dead') found.push([`dead:${m.uid}`, 'dead-in-party', `${label} is dead but still in the party.`]);
        else if (m.status === 'link-dead' || m.status === 'link-failed' || m.status === 'orphan' || m.status === 'extra') {
          const why = { 'link-dead': 'its partner died', 'link-failed': 'its link failed', orphan: 'it is an orphan waiting for a link', extra: "it isn't part of the run" }[m.status];
          found.push([`unusable:${m.uid}`, 'unusable-in-party', `${label} can't be used: ${why}.`]);
        } else if (m.status === 'alive' && m.linkId) {
          const link = links[m.linkId];
          for (const [opid, ouid] of Object.entries(link.members)) {
            if (opid === pid || !ouid) continue;
            const theirParty = partyUids.get(opid);
            if (theirParty && theirParty.size && !theirParty.has(ouid)) {
              found.push([`partner:${m.uid}:${ouid}`, 'partner-not-in-party', `${label}'s partner ${this.monLabel(mons[ouid])} isn't in ${this.name(opid)}'s party.`]);
            }
          }
          const t = this.primaryType(m.species);
          if (settings.typeClause && t && (typeLinks.get(t)?.size ?? 0) > 1) {
            found.push([`type:${t}`, 'type-clause', `More than one link on the combined team is primary ${t}-type.`]);
          }
        }
        if (cap !== undefined && pm.level > cap) found.push([`cap:${m.uid}:${cap}`, 'over-level-cap', `${label} is Lv${pm.level}, over the level cap of ${cap}.`]);
      }
      const prev = this.activeWarnings.get(pid) ?? new Set<string>();
      const now = new Set<string>();
      for (const [key, code, msg] of found) {
        now.add(key);
        if (!prev.has(key)) this.warn(pid, code, msg);
      }
      this.activeWarnings.set(pid, now);
    }
  }
}

export interface BuildOptions {
  initialSettings?: RuleSettings;
}

export function buildRunState(log: LogEntry[], opts: BuildOptions = {}): RunState {
  const sorted = [...log].sort((a, b) => a.seq - b.seq);
  const voided = undoVoids(sorted);
  // Disputes use the quorum in force when the vote happened.
  let quorum: RuleSettings['disputeQuorum'] = (opts.initialSettings ?? PRESETS.classic).disputeQuorum;
  const quorumAt = new Map<number, RuleSettings['disputeQuorum']>();
  for (const e of sorted) {
    if (e.kind === 'settings' && !voided.has(e.seq)) quorum = e.settings.disputeQuorum;
    quorumAt.set(e.seq, quorum);
  }
  const disputes = resolveDisputes(sorted, voided, (seq) => quorumAt.get(seq) ?? 'majority');

  const r = new Reducer(opts.initialSettings ?? PRESETS.classic);
  for (const e of sorted) {
    if (voided.has(e.seq)) continue;
    r.apply(e);
  }
  r.s.disputes = disputes;
  r.s.voided = [...voided].sort((a, b) => a - b);
  r.s.lastSeq = sorted.at(-1)?.seq ?? 0;
  return r.s;
}

// ---------------------------------------------------------------------------------------------
// Derived views used by the dashboard

/** Players currently ahead of a pacing gate (waiting for partners). */
export function pacing(state: RunState): { gate?: number; waiting: PlayerId[]; behind: PlayerId[] } {
  const ids = Object.keys(state.players);
  if (!state.settings.pacingGates.length || ids.length < 2) return { waiting: [], behind: [] };
  const min = Math.min(...ids.map((id) => state.players[id].badges));
  const gate = state.settings.pacingGates.find((g) => g > min);
  if (gate === undefined) return { waiting: [], behind: [] };
  // Anyone who has already reached the next gate waits for the slowest player.
  const waiting = ids.filter((id) => state.players[id].badges >= gate);
  const behind = ids.filter((id) => state.players[id].badges < gate);
  return { gate, waiting, behind: waiting.length ? behind : [] };
}

export function currentLevelCap(state: RunState, playerId: PlayerId): number | undefined {
  if (!state.settings.levelCaps) return undefined;
  const badges = state.players[playerId]?.badges ?? 0;
  return state.levelCaps.find((c) => c.badge === badges + 1)?.level;
}

/**
 * Team sync helper: which alive links can be fielded together (every partner usable),
 * and the best legal team of up to 6 links honouring the type clause.
 */
export function teamOptions(state: RunState): { usable: Link[]; typeConflicts: [string, string][]; suggested: string[] } {
  const usable = Object.values(state.links).filter(
    (l) => l.status === 'alive' && Object.values(l.members).every((uid) => !uid || state.mons[uid]?.status === 'alive'),
  );
  const prim = (l: Link) => {
    const types = new Set<string>();
    for (const uid of Object.values(l.members)) {
      const m = uid ? state.mons[uid] : undefined;
      if (!m) continue;
      const o = state.game.typeOverrides?.[m.species];
      const t = (o ?? typesFor(m.species, state.game.generation))[0];
      if (t) types.add(t);
    }
    return types;
  };
  const typeConflicts: [string, string][] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = prim(usable[i]);
      if ([...prim(usable[j])].some((t) => a.has(t))) typeConflicts.push([usable[i].id, usable[j].id]);
    }
  }
  // Greedy pick: highest combined level first, skipping type clashes when the clause is on.
  const level = (l: Link) => Object.values(l.members).reduce((n, uid) => n + (uid ? state.mons[uid]?.level ?? 0 : 0), 0);
  const suggested: string[] = [];
  const used = new Set<string>();
  for (const l of [...usable].sort((a, b) => level(b) - level(a))) {
    if (suggested.length >= 6) break;
    const t = prim(l);
    if (state.settings.typeClause && [...t].some((x) => used.has(x))) continue;
    suggested.push(l.id);
    t.forEach((x) => used.add(x));
  }
  return { usable, typeConflicts, suggested };
}

export type { AreaEncounter, GameInfo, PartyMember };
