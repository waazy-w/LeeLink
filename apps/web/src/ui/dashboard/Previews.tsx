import { useEffect } from 'react';
import type { RunCtx } from './ctx';
import { Empty } from '../common';

/** Low-fps snapshots of friends' screens. Subscribing is opt-in to save bandwidth. */
export function Previews({ ctx, on, setOn }: { ctx: RunCtx; on: boolean; setOn: (v: boolean) => void }) {
  useEffect(() => {
    ctx.conn.watchFrames(on);
  }, [on, ctx.conn]);
  const others = ctx.snap.players.filter((p) => p.playerId !== ctx.me);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-link-b" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Watch friends’ screens (≈1 fps)
      </label>
      {!on ? (
        <Empty>Previews are off.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {others.map((p) => (
            <figure key={p.playerId} className="overflow-hidden rounded-xl border border-ink-700">
              {ctx.snap.frames[p.playerId] ? (
                <img src={ctx.snap.frames[p.playerId]} alt={`${p.user.name}'s screen`} className="w-full [image-rendering:pixelated]" />
              ) : (
                <div className="flex aspect-[3/2] items-center justify-center text-xs text-ink-500">waiting for {p.user.name}…</div>
              )}
              <figcaption className="px-2 py-1 text-xs" style={{ color: p.color }}>
                {p.user.name}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
