import { useEffect, useState } from 'react';
import type { SaveVersion } from '@leelink/shared/protocol';
import type { RunCtx } from './ctx';
import { api } from '../../lib/api';
import { Empty, timeAgo } from '../common';

/** Cloud save history for this player in this run; any version can be restored. */
export function SavesPanel({ ctx, onRestore }: { ctx: RunCtx; onRestore: (data: Uint8Array, v: SaveVersion) => void }) {
  const [saves, setSaves] = useState<SaveVersion[]>([]);
  const [err, setErr] = useState<string>();
  const runId = ctx.snap.run!.id;

  useEffect(() => {
    api<{ saves: SaveVersion[] }>(`/api/runs/${runId}/saves?player=${ctx.me}`).then((r) => setSaves(r.saves), (e) => setErr(e.message));
  }, [runId, ctx.me, ctx.snap.lastSave?.id]);

  async function restore(v: SaveVersion) {
    if (!confirm(`Restore save v${v.version} from ${new Date(v.createdAt).toLocaleString()}? The game will reload with it.`)) return;
    const buf = await api<ArrayBuffer>(`/api/runs/${runId}/saves/${v.id}`);
    onRestore(new Uint8Array(buf), v);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-400">Every in-game save syncs here automatically. The last 100 versions are kept.</p>
      {err && <div className="text-xs text-rose-300">{err}</div>}
      {!saves.length && <Empty>No cloud saves yet — save in-game and it’ll appear here.</Empty>}
      <ul className="space-y-1">
        {saves.map((v, i) => (
          <li key={v.id} className="flex items-center gap-2 rounded-lg bg-ink-800 px-3 py-2 text-sm">
            <span className="font-mono text-xs text-ink-400">v{v.version}</span>
            <span className="flex-1">
              {timeAgo(v.createdAt)} {i === 0 && <span className="chip ml-1 bg-emerald-500/15 text-emerald-300">latest</span>}
            </span>
            <span className="font-mono text-[10px] text-ink-500">{(v.size / 1024).toFixed(0)} KB</span>
            {i > 0 && (
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => restore(v)}>
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
