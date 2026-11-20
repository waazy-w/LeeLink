import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { GameProfile } from '@leelink/shared/profiles/types';
import { identifyRom } from '@leelink/shared/rom/identify';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deleteLocalProfile, localProfiles, registry, saveLocalProfile, useProfilesLoaded } from '../lib/profiles';
import { Logo } from '../ui/common';

const GEN_LABEL = { 1: 'Gen 1', 2: 'Gen 2', 3: 'Gen 3', 4: 'Gen 4', 5: 'Gen 5' } as const;

/**
 * Game profiles: browse built-ins, and create ROM hack profiles that inherit from a base game
 * and override only what changed (addresses, location names, species tables, retypes, level caps).
 */
export function ProfilesPage() {
  const ready = useProfilesLoaded();
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<GameProfile | null>(null);
  const [, bump] = useState(0);
  const all = useMemo(() => (ready ? registry.all() : []), [ready, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const locals = new Set(localProfiles().map((p) => p.id));
  const sel = selected ? registry.resolve(selected) : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <header className="flex items-center gap-3">
        <Link to="/">
          <Logo className="text-xl" />
        </Link>
        <h1 className="text-2xl font-black">Game profiles</h1>
        <div className="flex-1" />
        <button className="btn-primary" onClick={() => setEditing(newHack())}>
          + New ROM hack profile
        </button>
      </header>
      <p className="max-w-3xl text-sm text-ink-300">
        A profile tells Lee Link where a game keeps its party, map and battle data. Hacks inherit from a base game and only override what they change.
        Use the <b>Debug</b> tab while playing to inspect memory and find addresses with the RAM search. Games without a profile run in manual mode.
      </p>
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <ul className="panel max-h-[70vh] space-y-0.5 overflow-y-auto p-2">
          {all.map((p) => (
            <li key={p.id}>
              <button onClick={() => setSelected(p.id)} className={`w-full rounded-lg px-3 py-2 text-left ${selected === p.id ? 'bg-ink-700' : 'hover:bg-ink-800'}`}>
                <div className="text-sm font-semibold">{p.name}</div>
                <div className="text-[11px] text-ink-400">
                  {GEN_LABEL[p.generation]} · {p.platform.toUpperCase()} {p.extends && `· extends ${p.extends}`} {locals.has(p.id) && '· local draft'}
                  {p.notes?.includes('unverified') && ' · unverified'}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="panel min-w-0 p-4">
          {sel ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h2 className="flex-1 text-lg font-bold">{sel.name}</h2>
                <button className="btn-secondary py-1 text-xs" onClick={() => setEditing({ ...newHack(), extends: sel.id, generation: sel.generation, platform: sel.platform, engine: sel.engine })}>
                  Make a hack of this
                </button>
                {locals.has(sel.id) && (
                  <>
                    <button className="btn-secondary py-1 text-xs" onClick={() => setEditing(registry.raw(sel.id)!)}>
                      Edit
                    </button>
                    <button className="btn-ghost py-1 text-xs" onClick={() => (deleteLocalProfile(sel.id), setSelected(undefined), bump((x) => x + 1))}>
                      Delete draft
                    </button>
                  </>
                )}
              </div>
              {sel.notes && <p className="text-xs text-amber-300">{sel.notes}</p>}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <dt className="text-ink-400">Engine</dt><dd>{sel.engine}</dd>
                <dt className="text-ink-400">Game codes</dt><dd className="font-mono text-xs">{sel.match.gameCodes?.join(', ') ?? sel.match.titles?.join(', ') ?? '—'}</dd>
                <dt className="text-ink-400">Locations</dt><dd>{Object.keys(sel.locations).length}</dd>
                <dt className="text-ink-400">Trainers</dt><dd>{Object.keys(sel.trainers ?? {}).length}</dd>
              </dl>
              {sel.levelCaps?.length ? (
                <div className="flex flex-wrap gap-1">
                  {sel.levelCaps.map((c) => (
                    <span key={c.badge} className="chip bg-ink-700 text-ink-200">
                      {c.label}: {c.level}
                    </span>
                  ))}
                </div>
              ) : null}
              <details>
                <summary className="cursor-pointer text-xs text-ink-400">Resolved JSON</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-ink-950 p-3 font-mono text-[10px]">{JSON.stringify({ ...sel, locations: `${Object.keys(sel.locations).length} entries`, trainers: `${Object.keys(sel.trainers ?? {}).length} entries` }, (k, v) => (typeof v === 'number' && k !== 'level' && k !== 'badge' && v > 0xffff ? `0x${v.toString(16)}` : v), 1)}</pre>
              </details>
            </div>
          ) : (
            <p className="text-sm text-ink-400">Select a profile.</p>
          )}
        </div>
      </div>
      {editing && <HackEditor initial={editing} onClose={() => setEditing(null)} onSaved={(id) => (setEditing(null), setSelected(id))} />}
    </div>
  );
}

function newHack(): GameProfile {
  return { id: '', name: '', extends: 'firered-bpre-rev0', generation: 3, platform: 'gba', engine: 'gen3', match: { sha1: [] }, addresses: {}, offsets: {}, locations: {} };
}

/** Edits only the overrides; everything else comes from the base profile. */
function HackEditor({ initial, onClose, onSaved }: { initial: GameProfile; onClose: () => void; onSaved: (id: string) => void }) {
  const { user } = useAuth();
  const [p, setP] = useState<GameProfile>(initial);
  const { id: _i, name: _n, extends: _e, match: _m, generation: _g, platform: _p, engine: _en, ...rest } = initial;
  const [overrides, setOverrides] = useState(JSON.stringify(rest, null, 2));
  const [err, setErr] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const bases = registry.all().filter((x) => !x.extends);

  function build(): GameProfile {
    const o = JSON.parse(overrides || '{}');
    const base = registry.resolve(p.extends ?? '');
    const id = p.id.trim() || p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const out: GameProfile = { addresses: {}, offsets: {}, locations: {}, ...o, id, name: p.name.trim(), extends: p.extends, match: p.match, generation: base?.generation ?? p.generation, platform: base?.platform ?? p.platform, engine: base?.engine ?? p.engine };
    // Validate by resolving through the registry (catches unknown bases / cycles).
    const r = registry;
    r.add(out);
    r.resolve(out.id);
    return out;
  }

  async function addRom(f: File) {
    const info = await identifyRom(new Uint8Array(await f.arrayBuffer()));
    if (!info) return setErr('Not a ROM');
    setP((x) => ({ ...x, name: x.name || info.title, match: { ...x.match, sha1: [...new Set([...(x.match.sha1 ?? []), info.sha1])] } }));
    setMsg(`Added hash ${info.sha1.slice(0, 12)}… (${info.gameCode}). The ROM itself stays on your device.`);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4" onClick={onClose}>
      <div className="panel my-6 w-full max-w-3xl space-y-4 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold">ROM hack profile</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name</label>
            <input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Radical Red 4.1" />
          </div>
          <div>
            <label className="label">Id</label>
            <input className="input font-mono" value={p.id} onChange={(e) => setP({ ...p, id: e.target.value })} placeholder="auto from name" />
          </div>
          <div>
            <label className="label">Base game</label>
            <select className="input" value={p.extends} onChange={(e) => setP({ ...p, extends: e.target.value })}>
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Match this hack's ROM (hash only)</label>
            <input type="file" className="text-xs" accept=".gba,.gbc,.gb,.nds" onChange={(e) => e.target.files?.[0] && addRom(e.target.files[0])} />
            <div className="mt-1 font-mono text-[10px] text-ink-400">{p.match.sha1?.map((s) => s.slice(0, 16)).join(', ') || 'no hashes yet'}</div>
          </div>
        </div>
        <div>
          <label className="label">Overrides (JSON — merged over the base)</label>
          <textarea className="input h-64 font-mono text-xs" value={overrides} onChange={(e) => setOverrides(e.target.value)} spellCheck={false} />
          <p className="mt-1 text-xs text-ink-400">
            Common overrides: <code>addresses</code> (e.g. <code>{'{"party": 33702532}'}</code>), <code>locations</code> (id → name), <code>areas</code>, <code>speciesTable</code> (internal index → national dex, for expanded species), <code>typeOverrides</code> (dex → types), <code>levelCaps</code>.
          </p>
        </div>
        {err && <div className="text-sm text-rose-300">{err}</div>}
        {msg && <div className="text-sm text-emerald-300">{msg}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              try {
                const out = build();
                saveLocalProfile(out);
                onSaved(out.id);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Save draft (this browser)
          </button>
          <button
            className="btn-primary"
            disabled={!user}
            title={user ? '' : 'Sign in to publish'}
            onClick={async () => {
              try {
                const out = build();
                await api(`/api/profiles/${encodeURIComponent(out.id)}`, { method: 'PUT', body: out });
                saveLocalProfile(out);
                onSaved(out.id);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Publish for everyone
          </button>
        </div>
      </div>
    </div>
  );
}
