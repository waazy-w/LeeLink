import { useEffect, useRef, useState } from 'react';
import type { Alert, Warning } from '@leelink/shared/engine/types';
import type { RunCtx } from './dashboard/ctx';

/** Plays a short alarm with WebAudio (no assets). */
function alarm(kind: 'death' | 'soft') {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'death' ? [880, 660, 440, 330] : [660, 880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'death' ? 'square' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16);
      o.stop(ctx.currentTime + i * 0.16 + 0.16);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* audio not available */
  }
}

/**
 * Loud alerts: a blocking "BOX IT NOW" modal when one of my Pokémon must be boxed,
 * toasts for everything else, and pre-catch warnings shown instantly.
 * Seen alerts are remembered per run so reloading doesn't replay them.
 */
export function AlertLayer({ ctx }: { ctx: RunCtx }) {
  const runId = ctx.snap.run!.id;
  const key = `leelink.seen.${runId}.${ctx.me}`;
  const seen = useRef<number>(Number(localStorage.getItem(key) ?? -1));
  const [modal, setModal] = useState<Alert[]>([]);
  const [toasts, setToasts] = useState<{ id: string; text: string; tone: 'info' | 'warn' | 'bad' }[]>([]);
  const first = useRef(true);

  useEffect(() => {
    const { alerts, warnings } = ctx.state;
    const since = seen.current;
    // On first load, only mark history as seen (no alert storm when opening an old run).
    if (first.current) {
      first.current = false;
      if (since < 0) {
        seen.current = ctx.state.lastSeq;
        localStorage.setItem(key, String(seen.current));
        return;
      }
    }
    const newAlerts = alerts.filter((a) => a.seq > since);
    const newWarnings = warnings.filter((w: Warning) => w.seq > since && w.playerId === ctx.me);
    if (!newAlerts.length && !newWarnings.length) return;
    seen.current = ctx.state.lastSeq;
    localStorage.setItem(key, String(seen.current));

    const mine = newAlerts.filter((a) => a.kind === 'link-death' && a.players.includes(ctx.me));
    if (mine.length || newAlerts.some((a) => a.kind === 'wipe' || a.kind === 'run-over')) {
      setModal((m) => [...m, ...mine, ...newAlerts.filter((a) => a.kind === 'wipe' || a.kind === 'run-over')]);
      alarm('death');
    } else if (newAlerts.some((a) => a.kind === 'link-death')) {
      alarm('soft');
    }
    const add = [
      ...newAlerts.filter((a) => !mine.includes(a) && a.kind !== 'wipe' && a.kind !== 'run-over').map((a) => ({ id: `a${a.seq}${a.kind}${a.message}`, text: a.message, tone: (a.kind === 'link-death' || a.kind === 'link-failed' ? 'bad' : 'info') as 'bad' | 'info' })),
      ...newWarnings.map((w) => ({ id: `w${w.seq}${w.code}${w.message}`, text: `${w.preCatch ? 'Before you catch: ' : ''}${w.message}`, tone: 'warn' as const })),
    ];
    if (add.length) {
      setToasts((t) => [...t, ...add].slice(-5));
      for (const x of add) setTimeout(() => setToasts((t) => t.filter((y) => y.id !== x.id)), x.tone === 'warn' ? 9000 : 6000);
    }
  }, [ctx.state, ctx.me, key]);

  return (
    <>
      <div className="pointer-events-none fixed top-3 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-3">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto animate-pop rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur ${
              t.tone === 'bad' ? 'border-rose-500/40 bg-rose-950/90 text-rose-100' : t.tone === 'warn' ? 'border-amber-500/40 bg-amber-950/90 text-amber-100' : 'border-ink-600 bg-ink-800/95'
            }`}
            onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
          >
            {t.tone === 'warn' ? '⚠ ' : t.tone === 'bad' ? '💀 ' : ''}
            {t.text}
          </div>
        ))}
      </div>
      {modal.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-rose-950/70 p-4 backdrop-blur-sm">
          <div className="panel w-full max-w-md animate-shake border-rose-500 p-6 text-center shadow-2xl shadow-rose-900">
            <div className="text-5xl">💀</div>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-rose-300">{modal[0].kind === 'link-death' ? 'BOX IT NOW' : modal[0].kind === 'wipe' ? 'WIPE' : 'RUN OVER'}</h2>
            <p className="mt-3 text-lg">{modal[0].message}</p>
            <button className="btn-danger mt-5 w-full py-3 text-base" onClick={() => setModal((m) => m.slice(1))}>
              {modal[0].kind === 'link-death' ? 'Done — it’s boxed' : 'OK'}
            </button>
            {modal.length > 1 && <div className="mt-2 text-xs text-ink-400">+{modal.length - 1} more</div>}
          </div>
        </div>
      )}
    </>
  );
}
