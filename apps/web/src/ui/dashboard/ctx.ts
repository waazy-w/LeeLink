import type { RunConnection, ConnectionSnapshot } from '../../lib/connection';
import type { RunState } from '@leelink/shared/engine/types';
import type { RunPlayer } from '@leelink/shared/protocol';

export interface RunCtx {
  conn: RunConnection;
  snap: ConnectionSnapshot;
  state: RunState;
  me: string;
  player(id: string): RunPlayer | undefined;
  color(id: string): string;
  name(id: string): string;
  isOwner: boolean;
}

export function makeCtx(conn: RunConnection, snap: ConnectionSnapshot): RunCtx | undefined {
  if (!snap.state || !snap.run) return undefined;
  const byId = new Map(snap.players.map((p) => [p.playerId, p]));
  return {
    conn,
    snap,
    state: snap.state,
    me: snap.me ?? '',
    player: (id) => byId.get(id),
    color: (id) => byId.get(id)?.color ?? '#888',
    name: (id) => byId.get(id)?.user.name ?? snap.state?.players[id]?.name ?? id,
    isOwner: !!snap.user && snap.run.ownerId === snap.user.id,
  };
}
