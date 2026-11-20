import { useState, type ReactNode } from 'react';
import { species as speciesInfo, speciesName, typesFor } from '@leelink/shared/data/species';
import type { MonStatus } from '@leelink/shared/engine/types';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-black tracking-tight ${className}`}>
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <circle cx="11" cy="16" r="8" fill="none" stroke="var(--color-link-a)" strokeWidth="3" />
        <circle cx="21" cy="16" r="8" fill="none" stroke="var(--color-link-b)" strokeWidth="3" />
      </svg>
      <span>
        Lee<span className="text-link-a">Link</span>
      </span>
    </span>
  );
}

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

/** Species sprite (pixel art), with a typed-colour fallback when offline. */
export function Sprite({ species, size = 48, dead = false, className = '' }: { species: number; size?: number; dead?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const t = typesFor(species, 5)[0] ?? 'normal';
  if (failed || !speciesInfo(species)) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white ${className}`}
        style={{ width: size, height: size, background: TYPE_COLORS[t], filter: dead ? 'grayscale(1) brightness(0.6)' : undefined }}
        title={speciesName(species)}
      >
        {speciesName(species).slice(0, 3).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`${SPRITE_BASE}/${species}.png`}
      alt={speciesName(species)}
      title={speciesName(species)}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 [image-rendering:pixelated] ${className}`}
      style={{ filter: dead ? 'grayscale(1) brightness(0.55)' : undefined }}
    />
  );
}

export const TYPE_COLORS: Record<string, string> = {
  normal: '#9ca3af', fighting: '#c2410c', flying: '#818cf8', poison: '#a855f7', ground: '#ca8a04', rock: '#a16207',
  bug: '#84cc16', ghost: '#6d28d9', steel: '#64748b', fire: '#f97316', water: '#3b82f6', grass: '#22c55e',
  electric: '#eab308', psychic: '#ec4899', ice: '#22d3ee', dragon: '#4f46e5', dark: '#44403c', fairy: '#f472b6',
};

export function TypeChip({ type }: { type: string }) {
  return (
    <span className="chip text-white" style={{ background: TYPE_COLORS[type] ?? '#555' }}>
      {type}
    </span>
  );
}

export const STATUS_STYLE: Record<MonStatus, { label: string; cls: string }> = {
  alive: { label: 'Alive', cls: 'bg-emerald-500/15 text-emerald-300' },
  pending: { label: 'Waiting', cls: 'bg-amber-500/15 text-amber-300' },
  dead: { label: 'Dead', cls: 'bg-rose-600/20 text-rose-300' },
  'link-dead': { label: 'Partner died', cls: 'bg-rose-600/20 text-rose-300' },
  'link-failed': { label: 'Link failed', cls: 'bg-ink-600 text-ink-300' },
  orphan: { label: 'Orphan', cls: 'bg-violet-500/15 text-violet-300' },
  extra: { label: 'Not in run', cls: 'bg-ink-700 text-ink-400' },
};

export function StatusChip({ status }: { status: MonStatus }) {
  const s = STATUS_STYLE[status];
  return <span className={`chip ${s.cls}`}>{s.label}</span>;
}

export function HpBar({ hp, maxHp }: { hp?: number; maxHp?: number }) {
  if (hp === undefined || !maxHp) return null;
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  const color = pct > 0.5 ? 'bg-emerald-400' : pct > 0.2 ? 'bg-amber-400' : 'bg-rose-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700" title={`${hp}/${maxHp} HP`}>
      <div className={`h-full ${color} transition-all`} style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

export function Avatar({ name, color, src, size = 28, online }: { name: string; color?: string; src?: string; size?: number; online?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      {src ? (
        <img src={src} alt="" width={size} height={size} className="rounded-full" style={{ outline: `2px solid ${color}` }} />
      ) : (
        <span className="inline-flex items-center justify-center rounded-full font-bold text-ink-950" style={{ width: size, height: size, background: color ?? '#888', fontSize: size * 0.45 }}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {online !== undefined && (
        <span className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-850 ${online ? 'bg-emerald-400' : 'bg-ink-500'}`} />
      )}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-ink-600 p-4 text-center text-sm text-ink-400">{children}</div>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold tracking-widest text-ink-400 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function timeAgo(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export function duration(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export { speciesName };
