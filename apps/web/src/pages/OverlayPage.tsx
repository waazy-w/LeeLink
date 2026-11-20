import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { RunConnection, useConnection } from '../lib/connection';
import { Sprite, speciesName } from '../ui/common';

/**
 * Transparent stream overlay for OBS: each player's party with linked partners, deaths and badges.
 * ?key=<overlayKey> (read-only access), &layout=row|column, &links=0 to hide the link list.
 */
export function OverlayPage() {
  const { id } = useParams();
  const [q] = useSearchParams();
  const [conn, setConn] = useState<RunConnection>();
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const c = new RunConnection(id!, q.get('key') ?? '');
    setConn(c);
    return () => c.close();
  }, [id, q]);
  const snap = useConnection(conn);
  if (!snap?.state || !snap.run) return null;
  const state = snap.state;
  const column = q.get('layout') === 'column';
  const deaths = Object.values(state.mons).filter((m) => m.status === 'dead').length;

  return (
    <div className={`flex gap-4 p-3 font-bold text-white [text-shadow:0_2px_4px_rgb(0_0_0/0.9)] ${column ? 'flex-col' : 'flex-row flex-wrap'}`}>
      {snap.players.map((p) => {
        const pr = snap.presence[p.playerId];
        const party = pr?.party ?? state.players[p.playerId]?.party ?? [];
        return (
          <div key={p.playerId} className="rounded-2xl bg-black/45 p-2 backdrop-blur-sm" style={{ borderTop: `3px solid ${p.color}` }}>
            <div className="flex items-center justify-between gap-4 px-1 text-sm">
              <span style={{ color: p.color }}>{p.user.name}</span>
              <span className="text-xs text-white/80">
                🏅{state.players[p.playerId]?.badges ?? 0} · {pr?.location ?? ''}
              </span>
            </div>
            <div className="flex gap-1">
              {party.map((m) => {
                const rm = state.mons[m.uid];
                const hp = 'hp' in m ? m.hp : undefined;
                const maxHp = 'maxHp' in m ? (m as { maxHp?: number }).maxHp : undefined;
                return (
                  <div key={m.uid} className="flex w-14 flex-col items-center">
                    <Sprite species={m.species} size={48} dead={rm?.status === 'dead' || rm?.status === 'link-dead'} />
                    <span className="w-full truncate text-center text-[10px]">{m.nickname || speciesName(m.species)}</span>
                    {hp !== undefined && maxHp ? (
                      <div className="mt-0.5 h-1 w-10 overflow-hidden rounded bg-white/20">
                        <div className="h-full bg-emerald-400" style={{ width: `${(hp / maxHp) * 100}%` }} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="self-center rounded-2xl bg-black/45 px-3 py-2 text-sm">
        💀 {deaths} · 🔗 {Object.values(state.links).filter((l) => l.status === 'alive').length}
      </div>
    </div>
  );
}
