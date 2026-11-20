import { useState } from 'react';
import type { RunCtx } from './ctx';
import { Empty, timeAgo } from '../common';
import type { FeedItem, LogEntry } from '@leelink/shared/engine/types';

const ICON: Record<FeedItem['kind'], string> = {
  catch: '◓', fail: '✕', death: '💀', badge: '🏅', warning: '⚠', link: '🔗', wipe: '☠', dispute: '⚖', undo: '↶', info: '·',
};
const COLOR: Partial<Record<FeedItem['kind'], string>> = {
  death: 'text-rose-300', wipe: 'text-rose-400', warning: 'text-amber-300', badge: 'text-yellow-300', link: 'text-sky-300', catch: 'text-emerald-300',
};

/** Activity feed with undo (own events) and disputes (anyone's events). */
export function Feed({ ctx }: { ctx: RunCtx }) {
  const { state, snap } = ctx;
  const [filter, setFilter] = useState<'all' | 'warnings' | 'deaths'>('all');
  const bySeq = new Map(snap.log.map((e) => [e.seq, e]));
  const items = [...state.feed]
    .filter((f) => filter === 'all' || (filter === 'warnings' ? f.kind === 'warning' : f.kind === 'death' || f.kind === 'wipe'))
    .reverse()
    .slice(0, 200);
  const openDisputes = Object.values(state.disputes).filter((d) => d.status === 'open');

  return (
    <div className="space-y-3">
      {openDisputes.map((d) => {
        const voted = d.votes[ctx.me] !== undefined;
        const target = bySeq.get(d.target);
        return (
          <div key={d.id} className="rounded-xl border border-violet-500/40 bg-violet-500/10 p-3 text-sm">
            <div className="font-semibold">⚖ {ctx.name(d.openedBy)} disputes: “{d.reason}”</div>
            <div className="mt-1 text-xs text-ink-300">{target ? describe(target, ctx) : `event #${d.target}`}</div>
            <div className="mt-1 text-xs text-ink-400">
              Votes: {Object.entries(d.votes).map(([p, v]) => `${ctx.name(p)} ${v ? '✓' : '✕'}`).join(' · ')} ({state.settings.disputeQuorum})
            </div>
            {!voted && (
              <div className="mt-2 flex gap-2">
                <button className="btn-secondary py-1" onClick={() => ctx.conn.append({ kind: 'dispute-vote', playerId: ctx.me, disputeId: d.id, approve: true })}>
                  Agree — void it
                </button>
                <button className="btn-ghost py-1" onClick={() => ctx.conn.append({ kind: 'dispute-vote', playerId: ctx.me, disputeId: d.id, approve: false })}>
                  Keep it
                </button>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-1">
        {(['all', 'warnings', 'deaths'] as const).map((f) => (
          <button key={f} className={`tab ${filter === f ? 'tab-active' : ''}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      {!items.length && <Empty>Nothing yet.</Empty>}
      <ul className="space-y-1">
        {items.map((f, i) => (
          <FeedRow key={`${f.seq}-${i}`} f={f} ctx={ctx} entry={bySeq.get(f.seq)} />
        ))}
      </ul>
    </div>
  );
}

function FeedRow({ f, ctx, entry }: { f: FeedItem; ctx: RunCtx; entry?: LogEntry }) {
  const [menu, setMenu] = useState(false);
  const [reason, setReason] = useState('');
  const own = entry && 'playerId' in entry && entry.playerId === ctx.me;
  const canAct = entry && (entry.kind === 'tracker' || entry.kind === 'action');
  return (
    <li className="group rounded-lg px-2 py-1 hover:bg-ink-800">
      <div className="flex items-start gap-2 text-sm">
        <span className={`w-4 shrink-0 text-center ${COLOR[f.kind] ?? 'text-ink-400'}`}>{ICON[f.kind]}</span>
        <span className="min-w-0 flex-1">
          {f.playerId && <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ctx.color(f.playerId) }} />}
          <span className={COLOR[f.kind] ?? 'text-ink-200'}>{f.text}</span>
        </span>
        <span className="shrink-0 text-[10px] text-ink-500">{timeAgo(f.at)}</span>
        {canAct && (
          <button className="shrink-0 text-xs text-ink-500 opacity-0 group-hover:opacity-100 hover:text-ink-200" onClick={() => setMenu((m) => !m)} title="Undo / dispute">
            ⋯
          </button>
        )}
      </div>
      {menu && entry && (
        <div className="mt-1 ml-6 flex flex-wrap items-center gap-2">
          {own ? (
            <button className="btn-secondary py-1 text-xs" onClick={() => (ctx.conn.append({ kind: 'undo', playerId: ctx.me, target: entry.seq }), setMenu(false))}>
              ↶ Undo this
            </button>
          ) : (
            <>
              <input className="input max-w-56 py-1 text-xs" placeholder="Why? e.g. misclick in a cutscene" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button
                className="btn-secondary py-1 text-xs"
                disabled={!reason.trim()}
                onClick={() => {
                  ctx.conn.append({ kind: 'dispute-open', playerId: ctx.me, disputeId: `d${Date.now().toString(36)}`, target: entry.seq, reason: reason.trim() });
                  setMenu(false);
                }}
              >
                ⚖ Dispute
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function describe(e: LogEntry, ctx: RunCtx) {
  if (e.kind === 'tracker') return `${ctx.name(e.playerId)}: ${e.event.type}`;
  if (e.kind === 'action') return `${ctx.name(e.playerId)}: ${e.action.type}`;
  return e.kind;
}
