import { useState } from 'react';
import { PRESETS, type PresetName, type RuleSettings } from '@leelink/shared/engine/settings';
import type { RunCtx } from './ctx';
import { api } from '../../lib/api';
import { Section } from '../common';

export const RULE_HELP: Record<keyof RuleSettings, string> = {
  failedEncounter: 'When one player fails their catch on an area',
  retryTokens: 'Re-rolls per player for the whole run',
  dupesClause: "Duplicate evolution lines don't count — the next encounter does",
  dupesScope: 'Whose catches make something a dupe',
  shinyClause: 'Shinies never use up the encounter',
  typeClause: 'No two links on the combined team may share a primary type',
  giftsAreEncounters: 'Gifts (fossils, Eevee…) count as the area encounter (starters always do)',
  graceUntilFirstEncounter: 'Faints before your first wild encounter don’t count (forced rival losses)',
  levelCaps: 'Show the next gym’s level cap and warn when over it',
  pacingGates: 'Badges where whoever is ahead waits for their partners',
  reviveShards: 'Limited link revives, earned as the whole team progresses',
  wipe: 'What a whiteout does',
  saveStates: 'Allow emulator save states (they break Nuzlocke integrity)',
  disputeQuorum: 'Votes needed to void an event',
};

export function RulesPanel({ ctx }: { ctx: RunCtx }) {
  const run = ctx.snap.run!;
  const [s, setS] = useState<RuleSettings>(ctx.state.settings);
  const [webhook, setWebhook] = useState('');
  const [msg, setMsg] = useState<string>();
  const editable = ctx.isOwner;
  const dirty = JSON.stringify(s) !== JSON.stringify(ctx.state.settings);
  const invite = `${location.origin}/join/${run.inviteCode}`;
  const overlay = `${location.origin}/overlay/${run.id}?key=${run.overlayKey}`;
  const set = <K extends keyof RuleSettings>(k: K, v: RuleSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  async function save(body: object, done: string) {
    try {
      await api(`/api/runs/${run.id}`, { method: 'PATCH', body });
      setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const Row = ({ k, children }: { k: keyof RuleSettings; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 border-b border-ink-800 py-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</div>
        <div className="text-xs text-ink-400">{RULE_HELP[k]}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
  const Toggle = ({ k }: { k: keyof RuleSettings }) => (
    <input type="checkbox" className="h-5 w-5 accent-link-b" disabled={!editable} checked={s[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} />
  );
  const Select = <K extends keyof RuleSettings>({ k, options }: { k: K; options: string[] }) => (
    <select className="input py-1" disabled={!editable} value={s[k] as string} onChange={(e) => set(k, e.target.value as never)}>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );

  return (
    <div className="space-y-5">
      <Section title="Invite friends">
        <div className="flex gap-2">
          <input className="input font-mono text-xs" readOnly value={invite} onFocus={(e) => e.target.select()} />
          <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(invite)}>
            Copy
          </button>
        </div>
        <div className="text-xs text-ink-400">
          Code <span className="font-mono text-ink-200">{run.inviteCode}</span> · {ctx.snap.players.length}/{run.maxPlayers} players
        </div>
      </Section>

      <Section title="Rules" right={!editable && <span className="text-xs text-ink-500">only the run owner can change rules</span>}>
        {editable && (
          <div className="flex gap-1">
            {(Object.keys(PRESETS) as PresetName[]).map((p) => (
              <button key={p} className="btn-secondary py-1 text-xs capitalize" onClick={() => setS(PRESETS[p])}>
                {p}
              </button>
            ))}
          </div>
        )}
        <div>
          <Row k="failedEncounter">
            <Select k="failedEncounter" options={['classic', 'retry-token', 'orphan']} />
          </Row>
          {s.failedEncounter === 'retry-token' && (
            <Row k="retryTokens">
              <input type="number" min={0} max={20} className="input w-20 py-1" disabled={!editable} value={s.retryTokens} onChange={(e) => set('retryTokens', Number(e.target.value))} />
            </Row>
          )}
          <Row k="dupesClause">
            <Toggle k="dupesClause" />
          </Row>
          {s.dupesClause && (
            <Row k="dupesScope">
              <Select k="dupesScope" options={['player', 'run']} />
            </Row>
          )}
          <Row k="shinyClause">
            <Toggle k="shinyClause" />
          </Row>
          <Row k="typeClause">
            <Toggle k="typeClause" />
          </Row>
          <Row k="giftsAreEncounters">
            <Toggle k="giftsAreEncounters" />
          </Row>
          <Row k="graceUntilFirstEncounter">
            <Toggle k="graceUntilFirstEncounter" />
          </Row>
          <Row k="levelCaps">
            <Toggle k="levelCaps" />
          </Row>
          <Row k="pacingGates">
            <input
              className="input w-36 py-1 font-mono text-xs"
              disabled={!editable}
              value={s.pacingGates.join(',')}
              placeholder="e.g. 1,2,3,4"
              onChange={(e) => set('pacingGates', e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => n > 0 && n <= 16))}
            />
          </Row>
          <Row k="reviveShards">
            <div className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="h-5 w-5 accent-link-b" disabled={!editable} checked={s.reviveShards.enabled} onChange={(e) => set('reviveShards', { ...s.reviveShards, enabled: e.target.checked })} />
              {s.reviveShards.enabled && (
                <>
                  <input type="number" step={0.25} min={0} className="input w-16 py-1" disabled={!editable} value={s.reviveShards.perBadge} onChange={(e) => set('reviveShards', { ...s.reviveShards, perBadge: Number(e.target.value) })} />
                  /badge, max
                  <input type="number" min={0} className="input w-14 py-1" disabled={!editable} value={s.reviveShards.max} onChange={(e) => set('reviveShards', { ...s.reviveShards, max: Number(e.target.value) })} />
                </>
              )}
            </div>
          </Row>
          <Row k="wipe">
            <Select k="wipe" options={['ends-run', 'kills-active-links']} />
          </Row>
          <Row k="saveStates">
            <Toggle k="saveStates" />
          </Row>
          <Row k="disputeQuorum">
            <Select k="disputeQuorum" options={['majority', 'unanimous']} />
          </Row>
        </div>
        {editable && dirty && (
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => save({ settings: s }, 'Rules updated — the change is recorded in the log.')}>
              Save rules
            </button>
            <button className="btn-ghost" onClick={() => setS(ctx.state.settings)}>
              Revert
            </button>
          </div>
        )}
      </Section>

      <Section title="Stream overlay (OBS)">
        <p className="text-xs text-ink-400">Add as a Browser Source (e.g. 1280×200). Transparent background, updates live.</p>
        <div className="flex gap-2">
          <input className="input font-mono text-xs" readOnly value={overlay} onFocus={(e) => e.target.select()} />
          <button className="btn-secondary" onClick={() => navigator.clipboard.writeText(overlay)}>
            Copy
          </button>
        </div>
      </Section>

      {editable && (
        <Section title="Discord webhook">
          <p className="text-xs text-ink-400">Posts deaths, badges, links and the final result to a channel. {run.hasWebhook ? 'A webhook is set.' : ''}</p>
          <div className="flex gap-2">
            <input className="input text-xs" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" />
            <button className="btn-secondary" disabled={!webhook} onClick={() => save({ webhookUrl: webhook }, 'Webhook saved.')}>
              Save
            </button>
            {run.hasWebhook && (
              <button className="btn-ghost" onClick={() => save({ webhookUrl: null }, 'Webhook removed.')}>
                Remove
              </button>
            )}
          </div>
        </Section>
      )}
      {msg && <div className="rounded-xl bg-ink-800 p-2 text-xs">{msg}</div>}
    </div>
  );
}
