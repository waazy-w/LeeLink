import { runStats } from '@leelink/shared/engine/stats';
import type { RunCtx } from './ctx';
import { Empty, Sprite, speciesName, timeAgo } from '../common';
import { useMemo } from 'react';

export function Graveyard({ ctx }: { ctx: RunCtx }) {
  const stats = useMemo(() => runStats(ctx.snap.log), [ctx.snap.log]);
  if (!stats.graveyard.length) return <Empty>No one has fallen. Yet.</Empty>;
  return (
    <ul className="space-y-1.5">
      {[...stats.graveyard].reverse().map((g) => (
        <li key={g.uid} className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-800/50 p-2">
          <Sprite species={g.species} size={40} dead />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold">
              {g.nickname || speciesName(g.species)} <span className="font-mono text-xs text-ink-400">Lv{g.level}</span>
              <span className="ml-2 text-xs" style={{ color: ctx.color(g.owner) }}>
                {ctx.name(g.owner)}
              </span>
            </div>
            <div className="truncate text-xs text-ink-400">
              {g.linkDeath
                ? `Lost with its partner · caught on ${g.area}`
                : `${g.cause?.trainerName ? `Fell to ${g.cause.trainerName}` : g.cause?.enemySpecies ? `Fell to a wild ${speciesName(g.cause.enemySpecies)}` : 'Fainted'}${g.cause?.enemySpecies && g.cause.trainerName ? `'s ${speciesName(g.cause.enemySpecies)}` : ''}${g.cause?.enemyLevel ? ` (Lv${g.cause.enemyLevel})` : ''}${g.place ? ` on ${g.place}` : ''}`}
            </div>
          </div>
          <span className="text-[10px] text-ink-500">{g.at ? timeAgo(g.at) : ''}</span>
        </li>
      ))}
    </ul>
  );
}
