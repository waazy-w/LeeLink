import { useMemo, useState } from 'react';
import { MAX_SPECIES, species as speciesInfo, speciesName } from '@leelink/shared/data/species';
import type { GameProfile } from '@leelink/shared/profiles/types';
import type { RunCtx } from './ctx';
import { Section, Sprite } from '../common';

/**
 * Quick buttons for games without a profile, or to fix something the tracker missed.
 * Everything here becomes a normal log entry, so it can be undone or disputed.
 */
export function ManualPanel({ ctx, profile, auto }: { ctx: RunCtx; profile?: GameProfile; auto: boolean }) {
  const { state, me } = ctx;
  const p = state.players[me];
  const [area, setArea] = useState(p?.location ?? '');
  const [query, setQuery] = useState('');
  const [nickname, setNickname] = useState('');
  const [level, setLevel] = useState('');
  const [picked, setPicked] = useState<number>();

  const areaOptions = useMemo(() => {
    const fromProfile = profile ? [...new Set(Object.values(profile.areas ?? {}).concat(Object.values(profile.locations)))] : [];
    return [...new Set([...state.areaOrder, ...fromProfile])].sort();
  }, [profile, state.areaOrder]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 1; i <= MAX_SPECIES && out.length < 8; i++) {
      if (speciesName(i).toLowerCase().startsWith(q) || String(i) === q) out.push(i);
    }
    return out;
  }, [query]);

  const myAlive = Object.values(state.mons).filter((m) => m.owner === me && m.status !== 'dead' && m.status !== 'extra');
  const used = p?.encounters[area.trim()];

  function log(result: 'caught' | 'failed') {
    if (!picked || !area.trim()) return;
    ctx.conn.append({
      kind: 'action', playerId: me,
      action: { type: 'manual-encounter', area: area.trim(), species: picked, result, nickname: nickname.trim() || undefined, level: Number(level) || undefined },
    });
    setQuery('');
    setPicked(undefined);
    setNickname('');
    setLevel('');
  }

  return (
    <div className="space-y-5">
      {auto ? (
        <p className="rounded-xl bg-ink-800 p-3 text-xs text-ink-300">Auto-tracking is on. Use these only if the tracker missed something; every entry can be undone from the feed.</p>
      ) : (
        <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-200">Manual mode: this game has no profile yet, so log encounters, deaths and badges here. The rules engine works exactly the same.</p>
      )}

      <Section title="Log an encounter">
        <label className="label">Area</label>
        <input className="input" list="ll-areas" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Route 1" />
        <datalist id="ll-areas">
          {areaOptions.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        {used && <div className="text-xs text-amber-300">You already have your {area} encounter ({speciesName(used.species)}, {used.status}).</div>}
        <label className="label mt-2">Pokémon</label>
        {picked ? (
          <div className="flex items-center gap-2 rounded-xl bg-ink-800 p-2">
            <Sprite species={picked} size={40} />
            <span className="flex-1 font-semibold">{speciesName(picked)}</span>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPicked(undefined)}>
              change
            </button>
          </div>
        ) : (
          <>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a name or dex number" />
            <div className="grid grid-cols-4 gap-1">
              {matches.map((s) => (
                <button key={s} className="flex flex-col items-center rounded-lg bg-ink-800 p-1 text-[10px] hover:bg-ink-700" onClick={() => setPicked(s)}>
                  <Sprite species={s} size={36} />
                  {speciesInfo(s)?.name}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="grid grid-cols-2 gap-2">
          <input className="input" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Nickname (optional)" />
          <input className="input" value={level} onChange={(e) => setLevel(e.target.value.replace(/\D/g, ''))} placeholder="Level" inputMode="numeric" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-primary" disabled={!picked || !area.trim()} onClick={() => log('caught')}>
            ◓ Caught it
          </button>
          <button className="btn-secondary" disabled={!picked || !area.trim()} onClick={() => log('failed')}>
            ✕ Failed / fled
          </button>
        </div>
      </Section>

      <Section title="Report a death">
        <div className="grid grid-cols-2 gap-1.5">
          {myAlive.map((m) => (
            <button
              key={m.uid}
              className="flex items-center gap-2 rounded-xl bg-ink-800 p-1.5 text-left text-xs hover:bg-rose-950/60"
              onClick={() => confirm(`Mark ${m.nickname || speciesName(m.species)} as dead? Its partners die too.`) && ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'manual-death', uid: m.uid } })}
            >
              <Sprite species={m.species} size={32} />
              <span className="truncate">{m.nickname || speciesName(m.species)}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Badges & location">
        <div className="flex items-center gap-2">
          <span className="text-sm">🏅 {p?.badges ?? 0}</span>
          <button className="btn-secondary py-1" onClick={() => ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'manual-badge', count: (p?.badges ?? 0) + 1 } })}>
            + Badge
          </button>
          <button className="btn-ghost py-1" disabled={!area.trim()} onClick={() => ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'manual-location', area: area.trim() } })}>
            I'm at “{area || '…'}”
          </button>
        </div>
      </Section>

      {!auto && (
        <Section title="My party">
          <p className="text-xs text-ink-400">Tick who's in your party so the team checks work.</p>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.values(state.mons)
              .filter((m) => m.owner === me)
              .map((m) => {
                const inParty = p?.party.some((x) => x.uid === m.uid);
                return (
                  <label key={m.uid} className="flex items-center gap-2 rounded-xl bg-ink-800 p-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={!!inParty}
                      onChange={() => {
                        const current = p?.party ?? [];
                        const next = inParty ? current.filter((x) => x.uid !== m.uid) : [...current, { uid: m.uid, species: m.species, level: m.level, nickname: m.nickname }].slice(0, 6);
                        ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'party', members: next } });
                      }}
                    />
                    <Sprite species={m.species} size={28} dead={m.status === 'dead'} />
                    <span className="truncate">{m.nickname || speciesName(m.species)}</span>
                  </label>
                );
              })}
          </div>
        </Section>
      )}

      <RunTools ctx={ctx} />
    </div>
  );
}

function RunTools({ ctx }: { ctx: RunCtx }) {
  const { state, me } = ctx;
  const p = state.players[me];
  const failedAreas = Object.entries(p?.encounters ?? {}).filter(([, e]) => e.status === 'failed').map(([a]) => a);
  const tokensLeft = Math.max(0, state.settings.retryTokens - (p?.retryUsed ?? 0));
  const shards = state.reviveShards.earned - state.reviveShards.used;
  const deadLinks = Object.values(state.links).filter((l) => l.status === 'dead');
  return (
    <>
      {state.settings.failedEncounter === 'retry-token' && (
        <Section title={`Retry tokens · ${tokensLeft} left`}>
          {failedAreas.length && tokensLeft ? (
            <div className="flex flex-wrap gap-1.5">
              {failedAreas.map((a) => (
                <button key={a} className="btn-secondary py-1 text-xs" onClick={() => ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'use-retry', area: a } })}>
                  Re-roll {a}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-400">{tokensLeft ? 'No failed encounters to re-roll.' : 'Out of tokens.'}</p>
          )}
        </Section>
      )}
      {state.settings.reviveShards.enabled && (
        <Section title={`Revive shards · ${shards} available`}>
          {deadLinks.length && shards > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {deadLinks.map((l) => (
                <button key={l.id} className="btn-secondary py-1 text-xs" onClick={() => confirm(`Spend a revive shard on the ${l.area} link?`) && ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'use-revive', linkId: l.id } })}>
                  Revive {l.area}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-400">Shards are earned when the slowest player reaches a badge ({state.settings.reviveShards.perBadge} per badge, max {state.settings.reviveShards.max}).</p>
          )}
        </Section>
      )}
      <Section title="End the run">
        <div className="flex gap-2">
          <button className="btn-secondary py-1 text-xs" onClick={() => confirm('Mark the run as won? 🏆') && ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'finish-run', result: 'won' } })}>
            🏆 We beat the game
          </button>
          <button className="btn-ghost py-1 text-xs" onClick={() => confirm('Abandon this run?') && ctx.conn.append({ kind: 'action', playerId: me, action: { type: 'finish-run', result: 'abandoned' } })}>
            Abandon
          </button>
        </div>
      </Section>
    </>
  );
}
