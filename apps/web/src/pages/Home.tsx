import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { registry, useProfilesLoaded } from '../lib/profiles';
import type { RunSummary } from '@leelink/shared/protocol';
import { PRESETS, type PresetName } from '@leelink/shared/engine/settings';
import { Logo, timeAgo } from '../ui/common';
import { SignIn } from '../ui/SignIn';
import { RomPicker } from '../ui/RomPicker';
import type { StoredRom } from '../storage/db';

const PRESET_BLURB: Record<PresetName, string> = {
  classic: 'Traditional Soul Link: fail = partner unusable, dupes + type clause, wipe ends the run.',
  casual: '3 retry tokens, revive shards, pacing gates at every badge, wipes only kill active links.',
  hardcore: 'No dupes clause, gifts don’t count, unanimous disputes.',
};

export function Home() {
  const { user, loading, signOut, rename, discordEnabled, discordUrl } = useAuth();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    if (user) void api<{ runs: RunSummary[] }>('/api/runs').then((r) => setRuns(r.runs));
  }, [user]);

  if (loading) return null;
  if (!user) return <Landing />;

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
      <header className="flex items-center gap-3">
        <Logo className="text-2xl" />
        <div className="flex-1" />
        <Link className="btn-ghost" to="/hall">
          Hall of fame
        </Link>
        <Link className="btn-ghost" to="/profiles">
          Game profiles
        </Link>
        <button className="btn-ghost" onClick={() => { const n = prompt('New name', user.name); if (n?.trim()) void rename(n.trim()); }}>
          {user.name}
        </button>
        {discordEnabled && !user.discord && (
          <a className="btn-ghost" href={discordUrl('/')}>
            Link Discord
          </a>
        )}
        <button className="btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      <section className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <div className="panel space-y-3 p-5">
          <h2 className="text-lg font-bold">Start a Soul Link</h2>
          <p className="text-sm text-ink-300">Create a run, pick the game and rules, then send your friends the invite link. 2–4 players.</p>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + New run
          </button>
        </div>
        <div className="panel space-y-3 p-5">
          <h2 className="text-lg font-bold">Join with a code</h2>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) nav(`/join/${code.trim().toUpperCase()}`);
            }}
          >
            <input className="input font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" />
            <button className="btn-secondary">Join</button>
          </form>
          <Link className="text-xs text-ink-400 underline" to="/play">
            Or just play solo (free play, no run)
          </Link>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold tracking-widest text-ink-400 uppercase">Your runs</h2>
        {runs.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {runs.map((r) => (
              <Link key={r.id} to={`/run/${r.id}`} className="panel block p-4 transition hover:border-link-b">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{r.name}</span>
                  <span className={`chip ${r.status === 'won' ? 'bg-emerald-500/15 text-emerald-300' : r.status === 'failed' ? 'bg-rose-500/15 text-rose-300' : 'bg-ink-700 text-ink-300'}`}>{r.status}</span>
                </div>
                <div className="mt-1 text-xs text-ink-400">
                  {r.gameName ?? 'Any game'} · started {timeAgo(r.createdAt)}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-400">No runs yet.</p>
        )}
      </section>
      {creating && <CreateRun onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateRun({ onClose }: { onClose: () => void }) {
  const ready = useProfilesLoaded();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<PresetName>('classic');
  const [players, setPlayers] = useState(2);
  const [rom, setRom] = useState<StoredRom>();
  const [profileId, setProfileId] = useState('');
  const [err, setErr] = useState<string>();
  const detected = rom ? registry.match(rom.info)?.profile : undefined;
  const chosen = profileId ? registry.resolve(profileId) : detected;

  async function create() {
    try {
      const { run } = await api<{ run: RunSummary }>('/api/runs', {
        body: { name, preset, maxPlayers: players, profileId: chosen?.id, gameName: chosen?.name ?? rom?.info.title, romSha1: rom?.sha1 },
      });
      if (rom) localStorage.setItem(`leelink.runrom.${run.id}`, rom.sha1);
      nav(`/run/${run.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink-950/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel my-8 w-full max-w-2xl space-y-5 p-6 animate-pop" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold">New Soul Link run</h2>
        <div>
          <label className="label">Run name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kanto with the boys" />
        </div>
        <div>
          <label className="label">Game — pick your ROM (stays on your device)</label>
          {rom ? (
            <div className="flex items-center justify-between rounded-xl bg-ink-800 p-3 text-sm">
              <span>
                {rom.fileName} · <span className="text-ink-400">{detected ? `Auto-tracking: ${detected.name}` : 'Manual mode (no profile)'}</span>
              </span>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRom(undefined)}>
                change
              </button>
            </div>
          ) : (
            <RomPicker compact onPick={setRom} />
          )}
          {ready && rom && (
            <div className="mt-2">
              <label className="label">Profile override (for ROM hacks)</label>
              <select className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                <option value="">{detected ? `Detected: ${detected.name}` : 'None — manual mode'}</option>
                {registry.all().filter((p) => p.platform === rom.info.platform || (p.platform.startsWith('gb') && rom.info.platform.startsWith('gb'))).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div>
          <label className="label">Rules preset (fine-tune later in the Rules tab)</label>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(PRESETS) as PresetName[]).map((p) => (
              <button key={p} onClick={() => setPreset(p)} className={`rounded-xl border p-3 text-left ${preset === p ? 'border-link-a bg-link-a/10' : 'border-ink-700'}`}>
                <div className="font-bold capitalize">{p}</div>
                <div className="mt-1 text-xs text-ink-400">{PRESET_BLURB[p]}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Players</label>
          <div className="flex gap-2">
            {[2, 3, 4].map((n) => (
              <button key={n} className={`btn ${players === n ? 'bg-link-b text-ink-950' : 'bg-ink-700'}`} onClick={() => setPlayers(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        {err && <div className="text-sm text-rose-300">{err}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={create}>
            Create run
          </button>
        </div>
      </div>
    </div>
  );
}

function Landing() {
  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-10 p-6 sm:p-10">
      <div className="space-y-5">
        <Logo className="text-4xl" />
        <h1 className="max-w-3xl text-4xl font-black tracking-tight sm:text-6xl">
          Soul Link runs, <span className="text-link-a">minus</span> the spreadsheet.
        </h1>
        <p className="max-w-2xl text-lg text-ink-300">
          Everyone plays their own game in the browser. Lee Link reads each game's memory, links your encounters, kills partners when one falls, and keeps the whole run honest — automatically.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['🔗', 'Auto-linking', 'Catches, faints and badges are detected from game memory and linked per route.'],
          ['💀', 'Loud deaths', 'When your partner’s Pokémon dies, you get a “box it now” alert instantly.'],
          ['⚖', 'Fair rules', 'Retry tokens, orphans, revive shards, pacing gates, undo and votes — all toggles.'],
        ].map(([i, t, d]) => (
          <div key={t} className="panel p-4">
            <div className="text-2xl">{i}</div>
            <div className="mt-2 font-bold">{t}</div>
            <div className="text-sm text-ink-400">{d}</div>
          </div>
        ))}
      </div>
      <SignIn title="Get started" autoFocus={false} />
    </div>
  );
}
