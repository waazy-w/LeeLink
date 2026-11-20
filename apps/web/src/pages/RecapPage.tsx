import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';
import type { RunStats } from '@leelink/shared/engine/stats';
import type { RunState } from '@leelink/shared/engine/types';
import type { RunPlayer, RunSummary } from '@leelink/shared/protocol';
import { Avatar, duration, Logo, Sprite, speciesName } from '../ui/common';

interface StatsResponse {
  run: RunSummary;
  players: RunPlayer[];
  stats: RunStats;
  state: RunState;
}

export function RecapPage() {
  const { id } = useParams();
  const [data, setData] = useState<StatsResponse>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    api<StatsResponse>(`/api/runs/${id}/stats`).then(setData, (e) => setErr(e.message));
  }, [id]);
  if (err) return <div className="p-10 text-center text-rose-300">{err}</div>;
  if (!data) return null;
  const { run, players, stats, state } = data;
  const name = (pid: string) => players.find((p) => p.playerId === pid)?.user.name ?? pid;
  const color = (pid: string) => players.find((p) => p.playerId === pid)?.color ?? '#888';
  const won = state.status === 'won';
  const survivors = Object.values(state.links).filter((l) => l.status === 'alive');

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-8">
      <Link to="/">
        <Logo className="text-xl" />
      </Link>
      <header className="space-y-2 text-center">
        <div className="text-6xl">{won ? '🏆' : state.status === 'failed' ? '🪦' : '📜'}</div>
        <h1 className="text-4xl font-black tracking-tight">{run.name}</h1>
        <p className="text-ink-300">
          {run.gameName} · {won ? 'Completed' : state.status === 'failed' ? 'Fell' : 'In progress'} · {duration(stats.durationMs)} · {stats.encounters} areas
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {players.map((p) => {
          const s = stats.perPlayer[p.playerId];
          return (
            <div key={p.playerId} className="panel space-y-2 p-4">
              <div className="flex items-center gap-2 font-bold">
                <Avatar name={p.user.name} color={p.color} src={p.user.avatar} />
                {p.user.name}
              </div>
              <dl className="grid grid-cols-2 gap-1 text-sm">
                <dt className="text-ink-400">Catches</dt><dd className="font-mono">{s?.catches ?? 0}</dd>
                <dt className="text-ink-400">Deaths</dt><dd className="font-mono text-rose-300">{s?.deaths ?? 0}</dd>
                <dt className="text-ink-400">Failed</dt><dd className="font-mono">{s?.failed ?? 0}</dd>
                <dt className="text-ink-400">Badges</dt><dd className="font-mono">{s?.badges ?? 0}</dd>
                <dt className="text-ink-400">Wins</dt><dd className="font-mono">{s?.trainerWins ?? 0}</dd>
              </dl>
            </div>
          );
        })}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {stats.mvp && (
          <section className="panel space-y-2 p-5">
            <h2 className="text-sm font-bold tracking-widest text-yellow-300 uppercase">MVP</h2>
            <div className="flex items-center gap-3">
              <Sprite species={stats.mvp.species} size={72} />
              <div>
                <div className="text-xl font-black">{stats.mvp.nickname || speciesName(stats.mvp.species)}</div>
                <div className="text-sm text-ink-400" style={{ color: color(stats.mvp.owner) }}>
                  {name(stats.mvp.owner)} · Lv{stats.mvp.level} · {stats.mvp.wins} trainer wins
                </div>
              </div>
            </div>
          </section>
        )}
        <section className="panel space-y-2 p-5">
          <h2 className="text-sm font-bold tracking-widest text-amber-300 uppercase">Closest calls</h2>
          {stats.closestCalls.length ? (
            <ul className="space-y-1 text-sm">
              {stats.closestCalls.map((c, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Sprite species={c.species} size={28} />
                  <span className="flex-1">
                    {c.nickname || speciesName(c.species)} <span style={{ color: color(c.owner) }}>({name(c.owner)})</span> on {c.place}
                  </span>
                  <span className="font-mono text-rose-300">
                    {c.hp}/{c.maxHp}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-400">No close calls recorded.</p>
          )}
        </section>
      </div>

      {survivors.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-bold tracking-widest text-emerald-300 uppercase">{won ? 'Hall of fame team' : 'Surviving links'}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {survivors.map((l) => (
              <div key={l.id} className="panel flex items-center gap-3 p-3">
                <span className="w-24 truncate text-xs text-ink-400">{l.area}</span>
                {Object.entries(l.members).map(([pid, uid]) => {
                  const m = uid ? state.mons[uid] : undefined;
                  return m ? (
                    <div key={pid} className="flex items-center gap-1 text-sm" style={{ color: color(pid) }}>
                      <Sprite species={m.species} size={36} />
                      {m.nickname || speciesName(m.species)}
                    </div>
                  ) : null;
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-bold tracking-widest text-rose-300 uppercase">Graveyard · {stats.graveyard.length}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {stats.graveyard.map((g) => (
            <div key={g.uid} className="flex items-center gap-2 rounded-xl border border-ink-700 p-2 text-sm">
              <Sprite species={g.species} size={36} dead />
              <div className="min-w-0">
                <div className="truncate font-semibold">
                  {g.nickname || speciesName(g.species)} <span className="text-xs" style={{ color: color(g.owner) }}>{name(g.owner)}</span>
                </div>
                <div className="truncate text-xs text-ink-400">
                  Lv{g.level} · {g.linkDeath ? 'lost with its partner' : g.cause?.trainerName ?? (g.cause?.enemySpecies ? `wild ${speciesName(g.cause.enemySpecies)}` : 'fainted')} {g.place ? `· ${g.place}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
