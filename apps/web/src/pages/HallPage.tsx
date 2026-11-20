import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import type { RunStats } from '@leelink/shared/engine/stats';
import type { RunPlayer, RunSummary } from '@leelink/shared/protocol';
import { Avatar, duration, Logo, timeAgo } from '../ui/common';

type Entry = Omit<RunSummary, 'overlayKey'> & { players: RunPlayer[]; stats: RunStats };

export function HallPage() {
  const [data, setData] = useState<{ runs: Entry[]; fallen: Entry[] }>();
  useEffect(() => {
    void api<{ runs: Entry[]; fallen: Entry[] }>('/api/hall-of-fame').then(setData);
  }, []);
  const card = (r: Entry, won: boolean) => (
    <Link key={r.id} to={`/run/${r.id}/recap`} className={`panel block space-y-2 p-4 transition ${won ? "hover:border-yellow-400" : "hover:border-rose-400"}`}>
      <div className="flex items-center justify-between">
        <span className="font-bold">
          {won ? '🏆' : '🪦'} {r.name}
        </span>
        <span className="text-xs text-ink-400">{timeAgo(r.createdAt)}</span>
      </div>
      <div className="text-xs text-ink-400">
        {r.gameName} · {duration(r.stats.durationMs)} · {r.stats.graveyard.length} deaths
      </div>
      <div className="flex gap-1">
        {r.players.map((p) => (
          <Avatar key={p.playerId} name={p.user.name} color={p.color} src={p.user.avatar} size={22} />
        ))}
      </div>
    </Link>
  );
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-4 sm:p-8">
      <Link to="/">
        <Logo className="text-xl" />
      </Link>
      <h1 className="text-3xl font-black">Hall of fame</h1>
      {!data ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">{data.runs.length ? data.runs.map((r) => card(r, true)) : <p className="text-ink-400">No completed runs yet. Be the first.</p>}</div>
          {data.fallen.length > 0 && (
            <>
              <h2 className="text-sm font-bold tracking-widest text-ink-400 uppercase">Fallen runs</h2>
              <div className="grid gap-3 sm:grid-cols-2">{data.fallen.map((r) => card(r, false))}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
