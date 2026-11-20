import type { RunCtx } from './ctx';
import { Empty, Sprite, speciesName } from '../common';

const LINK_STYLE = {
  alive: 'border-emerald-500/30',
  pending: 'border-amber-500/30',
  dead: 'border-rose-600/40 bg-rose-950/20',
  failed: 'border-ink-700 opacity-60',
  orphaned: 'border-violet-500/30',
} as const;

/** Every area in encounter order: who caught what, and link status. */
export function LinkBoard({ ctx, compact }: { ctx: RunCtx; compact?: boolean }) {
  const { state } = ctx;
  const ids = Object.keys(state.players);
  const areas = state.areaOrder;
  const orphanLinks = Object.values(state.links).filter((l) => l.id.startsWith('orphan-'));
  if (!areas.length && !orphanLinks.length) return <Empty>No encounters yet. Head into the tall grass!</Empty>;

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 px-2 text-[10px] font-bold tracking-widest text-ink-400 uppercase" style={{ gridTemplateColumns: `minmax(70px,1fr) repeat(${ids.length}, minmax(0,1.3fr))` }}>
        <span>Area</span>
        {ids.map((pid) => (
          <span key={pid} className="truncate" style={{ color: ctx.color(pid) }}>
            {ctx.name(pid)}
          </span>
        ))}
      </div>
      {[...areas].reverse().map((area) => {
        const link = Object.values(state.links).find((l) => l.area === area && !l.id.startsWith('orphan-'));
        const status = link?.status ?? 'pending';
        return (
          <div key={area} className={`grid items-center gap-2 rounded-xl border bg-ink-800/60 p-2 ${LINK_STYLE[status]}`} style={{ gridTemplateColumns: `minmax(70px,1fr) repeat(${ids.length}, minmax(0,1.3fr))` }}>
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">{area}</div>
              <div className="text-[10px] text-ink-400 uppercase">{status === 'alive' ? '🔗 linked' : status === 'dead' ? '💀 dead' : status === 'failed' ? '✕ failed' : status === 'orphaned' ? 'orphaned' : '… waiting'}</div>
            </div>
            {ids.map((pid) => {
              const enc = state.players[pid].encounters[area];
              const m = enc?.uid ? state.mons[enc.uid] : undefined;
              if (!enc) return <span key={pid} className="text-xs text-ink-500">—</span>;
              if (enc.status === 'failed') {
                return (
                  <div key={pid} className="flex items-center gap-1 text-xs text-ink-400 line-through">
                    {!compact && <Sprite species={enc.species} size={28} dead />}
                    {speciesName(enc.species)}
                  </div>
                );
              }
              const dead = m?.status === 'dead' || m?.status === 'link-dead';
              return (
                <div key={pid} className="flex min-w-0 items-center gap-1">
                  {!compact && <Sprite species={m?.species ?? enc.species} size={32} dead={dead} />}
                  <div className="min-w-0 leading-tight">
                    <div className={`truncate text-xs font-semibold ${dead ? 'text-rose-300 line-through' : ''}`}>{m?.nickname || speciesName(m?.species ?? enc.species)}</div>
                    <div className="text-[10px] text-ink-400">{m ? `Lv${m.level}` : enc.status === 'pending' ? 'in battle…' : 'caught'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {orphanLinks.map((l) => (
        <div key={l.id} className={`grid items-center gap-2 rounded-xl border bg-ink-800/60 p-2 ${LINK_STYLE[l.status]}`} style={{ gridTemplateColumns: `minmax(70px,1fr) repeat(${ids.length}, minmax(0,1.3fr))` }}>
          <div className="truncate text-xs font-semibold">{l.area}</div>
          {ids.map((pid) => {
            const m = l.members[pid] ? state.mons[l.members[pid]!] : undefined;
            return m ? (
              <div key={pid} className="flex items-center gap-1 text-xs">
                {!compact && <Sprite species={m.species} size={28} dead={m.status !== 'alive'} />}
                {m.nickname || speciesName(m.species)}
              </div>
            ) : (
              <span key={pid}>—</span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
