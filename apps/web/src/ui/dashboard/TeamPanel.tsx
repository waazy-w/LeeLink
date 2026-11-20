import { currentLevelCap, pacing, teamOptions } from '@leelink/shared/engine/reducer';
import { typesFor } from '@leelink/shared/data/species';
import type { RunCtx } from './ctx';
import { Avatar, Empty, HpBar, Section, Sprite, StatusChip, TypeChip, speciesName } from '../common';

/** Every player's live party side by side, plus the team sync helper. */
export function TeamPanel({ ctx }: { ctx: RunCtx }) {
  const { state, snap } = ctx;
  const ids = Object.keys(state.players);
  const team = teamOptions(state);
  const gate = pacing(state);

  return (
    <div className="space-y-5">
      {ids.map((pid) => {
        const pres = snap.presence[pid];
        const party = pres?.party ?? state.players[pid].party.map((m) => ({ ...m, maxHp: undefined, status: 'ok' as const }));
        const cap = currentLevelCap(state, pid);
        return (
          <Section
            key={pid}
            title={ctx.name(pid)}
            right={
              <div className="flex items-center gap-2 text-[11px] text-ink-400">
                <span>🏅 {state.players[pid].badges}</span>
                {cap && <span title="Level cap">cap {cap}</span>}
                <span className="max-w-28 truncate">{pres?.location ?? state.players[pid].location ?? '—'}</span>
                <Avatar name={ctx.name(pid)} color={ctx.color(pid)} size={18} online={pres?.online} />
              </div>
            }
          >
            {party.length ? (
              <div className="grid grid-cols-2 gap-1.5">
                {party.map((m) => {
                  const rm = state.mons[m.uid];
                  const over = cap !== undefined && m.level > cap;
                  return (
                    <div key={m.uid} className="flex items-center gap-2 rounded-xl bg-ink-800 p-1.5" style={{ boxShadow: rm?.linkId ? `inset 3px 0 0 ${ctx.color(pid)}` : undefined }}>
                      <Sprite species={m.species} size={40} dead={rm?.status === 'dead' || m.hp === 0} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="truncate text-xs font-semibold">{m.nickname || speciesName(m.species)}</span>
                          <span className={`font-mono text-[11px] ${over ? 'font-bold text-rose-400' : 'text-ink-400'}`}>Lv{m.level}</span>
                        </div>
                        <HpBar hp={m.hp} maxHp={m.maxHp} />
                        <div className="mt-0.5 flex items-center gap-1">
                          {rm ? <StatusChip status={rm.status} /> : <span className="chip bg-ink-700 text-ink-400">untracked</span>}
                          {m.status !== 'ok' && <span className="chip bg-amber-500/15 text-amber-300">{m.status}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty>No party yet</Empty>
            )}
          </Section>
        );
      })}

      {gate.gate !== undefined && gate.waiting.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          Pacing gate {gate.gate}: {gate.waiting.map(ctx.name).join(', ')} waiting for {gate.behind.map(ctx.name).join(', ')}.
        </div>
      )}

      <Section title="Team sync helper">
        <p className="text-xs text-ink-400">Links that can be fielded together (every partner alive). Suggested team respects the type clause.</p>
        {team.usable.length ? (
          <div className="space-y-1.5">
            {team.usable.map((l) => {
              const suggested = team.suggested.includes(l.id);
              const clashes = team.typeConflicts.filter((c) => c.includes(l.id)).map((c) => (c[0] === l.id ? c[1] : c[0]));
              return (
                <div key={l.id} className={`rounded-xl border p-2 ${suggested ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-ink-700'}`}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-semibold">{l.area}</span>
                    {suggested ? <span className="chip bg-emerald-500/15 text-emerald-300">suggested</span> : clashes.length ? <span className="chip bg-amber-500/15 text-amber-300">type clash</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(l.members).map(([pid, uid]) => {
                      const m = uid ? state.mons[uid] : undefined;
                      if (!m) return null;
                      return (
                        <div key={pid} className="flex items-center gap-1">
                          <Sprite species={m.species} size={28} />
                          <div className="text-[11px] leading-tight">
                            <div style={{ color: ctx.color(pid) }}>{m.nickname || speciesName(m.species)}</div>
                            <div className="flex gap-0.5">{typesFor(m.species, state.game.generation).slice(0, 1).map((t) => <TypeChip key={t} type={state.game.typeOverrides?.[m.species]?.[0] ?? t} />)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty>No complete links yet</Empty>
        )}
      </Section>
    </div>
  );
}
