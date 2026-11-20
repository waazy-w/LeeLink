import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { RunConnection, useConnection } from '../lib/connection';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { registry, useProfilesLoaded } from '../lib/profiles';
import { saveStore, romStore, type StoredRom } from '../storage/db';
import { sha1Hex } from '@leelink/shared/rom/identify';
import { currentLevelCap, pacing } from '@leelink/shared/engine/reducer';
import type { SaveVersion } from '@leelink/shared/protocol';
import type { PokemonData } from '@leelink/shared/model';
import { EmulatorView, type EmulatorHandle } from '../ui/EmulatorView';
import { RomPicker } from '../ui/RomPicker';
import { TrackerSession } from '../tracking/session';
import { makeCtx, type RunCtx } from '../ui/dashboard/ctx';
import { TeamPanel } from '../ui/dashboard/TeamPanel';
import { LinkBoard } from '../ui/dashboard/LinkBoard';
import { Feed } from '../ui/dashboard/Feed';
import { Chat } from '../ui/dashboard/Chat';
import { Graveyard } from '../ui/dashboard/Graveyard';
import { ManualPanel } from '../ui/dashboard/ManualPanel';
import { RulesPanel } from '../ui/dashboard/RulesPanel';
import { SavesPanel } from '../ui/dashboard/SavesPanel';
import { DebugPanel } from '../ui/dashboard/DebugPanel';
import { Previews } from '../ui/dashboard/Previews';
import { AlertLayer } from '../ui/AlertLayer';
import { Avatar, Logo } from '../ui/common';
import { SignIn } from '../ui/SignIn';

type Tab = 'team' | 'links' | 'feed' | 'chat' | 'grave' | 'log' | 'screens' | 'saves' | 'rules' | 'debug';
const TABS: { id: Tab; label: string }[] = [
  { id: 'team', label: 'Team' },
  { id: 'links', label: 'Links' },
  { id: 'feed', label: 'Feed' },
  { id: 'chat', label: 'Chat' },
  { id: 'log', label: 'Log' },
  { id: 'grave', label: 'Graveyard' },
  { id: 'screens', label: 'Screens' },
  { id: 'saves', label: 'Saves' },
  { id: 'rules', label: 'Rules' },
  { id: 'debug', label: 'Debug' },
];

export function RunPage() {
  const { id } = useParams();
  const { user, loading } = useAuth();
  const [conn, setConn] = useState<RunConnection>();

  useEffect(() => {
    if (!user || !id) return;
    const c = new RunConnection(id);
    setConn(c);
    return () => c.close();
  }, [user, id]);

  const snap = useConnection(conn);
  if (loading) return null;
  if (!user) return <SignIn />;
  if (!snap || snap.status === 'connecting') return <Center>Connecting…</Center>;
  if (snap.status === 'error') return <Center>{snap.error} · <Link className="text-link-b" to="/">Home</Link></Center>;
  const ctx = conn && makeCtx(conn, snap);
  if (!ctx) return <Center>Loading run…</Center>;
  return <RunRoom ctx={ctx} />;
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-ink-300">{children}</div>;
}

function RunRoom({ ctx }: { ctx: RunCtx }) {
  const run = ctx.snap.run!;
  const profilesReady = useProfilesLoaded();
  const [rom, setRom] = useState<StoredRom>();
  const [save, setSave] = useState<Uint8Array | null>();
  const [emuKey, setEmuKey] = useState(0);
  const [handle, setHandle] = useState<EmulatorHandle>();
  const [panel, setPanel] = useState(() => localStorage.getItem('leelink.panel') !== '0');
  const [tab, setTab] = useState<Tab>('team');
  const [watch, setWatch] = useState(false);
  const [share, setShare] = useState(() => localStorage.getItem('leelink.share') !== '0');
  const tracker = useRef<TrackerSession>(undefined);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const profile = useMemo(() => {
    if (!profilesReady || !rom) return undefined;
    const fromRun = run.profileId ? registry.resolve(run.profileId) : undefined;
    // Use the run's profile only if it fits this ROM's platform; otherwise detect.
    if (fromRun && fromRun.platform === (rom.info.platform === 'gbc' ? fromRun.platform : rom.info.platform)) return fromRun;
    return registry.match(rom.info)?.profile;
  }, [profilesReady, rom, run.profileId]);

  // Pick up the last ROM used in this run automatically.
  useEffect(() => {
    const last = localStorage.getItem(`leelink.runrom.${run.id}`);
    if (last) void romStore.get(last).then((r) => r && setRom(r));
  }, [run.id]);

  // Load the newest of the local and cloud saves before booting.
  useEffect(() => {
    if (!rom) return;
    setSave(undefined);
    let cancelled = false;
    (async () => {
      const local = await saveStore.get(`${run.id}:${rom.sha1}`);
      let cloud: { data: Uint8Array; at: number } | undefined;
      try {
        const { saves } = await api<{ saves: SaveVersion[] }>(`/api/runs/${run.id}/saves?player=${ctx.me}`);
        if (saves[0] && (!local || saves[0].createdAt > local.updatedAt)) {
          cloud = { data: new Uint8Array(await api<ArrayBuffer>(`/api/runs/${run.id}/saves/${saves[0].id}`)), at: saves[0].createdAt };
        }
      } catch {
        /* offline: use local */
      }
      if (!cancelled) setSave(cloud?.data ?? local?.data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [rom, run.id, ctx.me]);

  const onReady = useCallback(
    (h: EmulatorHandle) => {
      setHandle(h);
      void romStore.put({ ...rom!, lastPlayedAt: Date.now() });
      const session = new TrackerSession(h.core, profile, {
        onEvents: (events) => events.forEach((event) => ctxRef.current.conn.append({ kind: 'tracker', playerId: ctxRef.current.me, event })),
        onParty: (members) => ctxRef.current.conn.append({ kind: 'action', playerId: ctxRef.current.me, action: { type: 'party', members } }),
      });
      // Seed with what the run already knows so resumed sessions don't re-report old catches.
      const st = ctxRef.current.state;
      const mine = Object.values(st.mons).filter((m) => m.owner === ctxRef.current.me && !m.uid.startsWith('manual:'));
      session.seed(
        mine.map((m) => ({ uid: m.uid, species: m.species, nickname: m.nickname, level: m.level, status: 'ok', isEgg: false, otId: 0, heldItem: 0, moves: [], experience: 0 }) as PokemonData),
        new Set(mine.filter((m) => m.status === 'dead').map((m) => m.uid)),
      );
      tracker.current = session;
    },
    [profile, rom],
  );

  // Presence (1 Hz), cloud save sync (every 3 s, only after the save is stable) and screen previews.
  useEffect(() => {
    if (!handle || !rom) return;
    let lastSaveHash = '';
    let candidate = '';
    let tick = 0;
    const started = Date.now();
    const timer = setInterval(async () => {
      tick++;
      const c = ctxRef.current;
      const st = tracker.current?.lastState;
      c.conn.presence({
        romSha1: rom.sha1,
        romTitle: rom.info.title,
        mode: tracker.current?.automatic ? 'auto' : 'manual',
        location: st?.inGame ? st.location.area : c.state.players[c.me]?.location,
        badges: st?.inGame ? st.badges.filter(Boolean).length : c.state.players[c.me]?.badges,
        inBattle: st?.battle.active,
        party: st?.inGame
          ? st.party.filter((s) => s.mon).map((s) => ({ uid: s.mon!.uid, species: s.mon!.species, nickname: s.mon!.nickname, level: s.mon!.level, hp: s.mon!.hp, maxHp: s.mon!.maxHp, status: s.mon!.status }))
          : undefined,
        playTimeSec: Math.round((Date.now() - started) / 1000),
      });
      if (share && tick % 1 === 0) {
        const src = handle.runner.snapshot(0, 0.4);
        if (src) void downscale(src, 160).then((d) => d && c.conn.frame(d));
      }
      if (tick % 3 === 0) {
        const data = handle.core.exportSave();
        if (!data?.length) return;
        const h = await sha1Hex(data);
        // Require two identical reads so we never upload a save caught mid-write.
        if (h !== lastSaveHash && h === candidate) {
          lastSaveHash = h;
          await saveStore.put({ key: `${run.id}:${rom.sha1}`, data, updatedAt: Date.now() });
          void api(`/api/runs/${run.id}/saves`, { method: 'PUT', raw: data as BodyInit }).catch(() => undefined);
        }
        candidate = h;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [handle, rom, run.id, share]);

  useEffect(() => localStorage.setItem('leelink.panel', panel ? '1' : '0'), [panel]);
  useEffect(() => localStorage.setItem('leelink.share', share ? '1' : '0'), [share]);

  const gate = pacing(ctx.state);
  const waiting = gate.waiting.includes(ctx.me);
  const cap = currentLevelCap(ctx.state, ctx.me);
  const romMismatch = rom && run.romSha1 && rom.sha1 !== run.romSha1;

  return (
    <div className="flex h-full flex-col">
      <AlertLayer ctx={ctx} />
      <header className="flex items-center gap-3 border-b border-ink-800 bg-ink-900/80 px-3 py-2 backdrop-blur">
        <Link to="/">
          <Logo className="text-base" />
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{run.name}</div>
          <div className="truncate text-[11px] text-ink-400">
            {profile?.name ?? run.gameName ?? 'Manual mode'} · {ctx.state.status !== 'active' ? ctx.state.status.toUpperCase() : run.status === 'lobby' ? 'Lobby' : 'Live'}
            {cap && ` · Level cap ${cap}`}
          </div>
        </div>
        <div className="flex-1" />
        <div className="hidden items-center gap-2 sm:flex">
          {ctx.snap.players.map((p) => {
            const pr = ctx.snap.presence[p.playerId];
            const match = !run.romSha1 || !pr?.romSha1 ? undefined : pr.romSha1 === run.romSha1;
            return (
              <div key={p.playerId} className="flex items-center gap-1.5 rounded-full bg-ink-800 py-0.5 pr-2.5 pl-0.5 text-xs" title={match === false ? 'Playing a different ROM (randomizer?)' : undefined}>
                <Avatar name={p.user.name} color={p.color} src={p.user.avatar} size={22} online={pr?.online} />
                {p.user.name}
                {match === false && <span className="text-amber-300">≠ROM</span>}
                <span className="text-ink-400">🏅{ctx.state.players[p.playerId]?.badges ?? 0}</span>
              </div>
            );
          })}
        </div>
        {ctx.snap.status === 'offline' && <span className="chip bg-amber-500/15 text-amber-300">reconnecting…</span>}
        {ctx.snap.pending > 0 && <span className="chip bg-ink-700 text-ink-300">syncing {ctx.snap.pending}</span>}
        {ctx.state.status === 'won' || ctx.state.status === 'failed' ? (
          <Link className="btn-secondary py-1 text-xs" to={`/run/${run.id}/recap`}>
            Recap
          </Link>
        ) : null}
        <button className="btn-ghost px-2 py-1" onClick={() => setPanel((p) => !p)} title="Toggle dashboard">
          {panel ? '⇥' : '⇤'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="relative min-h-0 min-w-0 flex-1">
          {!rom ? (
            <div className="mx-auto max-w-2xl space-y-4 overflow-y-auto p-6">
              <h2 className="text-xl font-bold">Pick your ROM</h2>
              <p className="text-sm text-ink-300">
                Each player plays their own copy. Your ROM never leaves this device; only its hash is shared so the lobby can confirm everyone has the same game.
                {run.romSha1 && <> Run ROM: <span className="font-mono text-xs">{run.romSha1.slice(0, 12)}…</span></>}
              </p>
              <RomPicker
                expectSha1={run.romSha1}
                onPick={(r) => {
                  localStorage.setItem(`leelink.runrom.${run.id}`, r.sha1);
                  setRom(r);
                }}
              />
            </div>
          ) : save === undefined || !profilesReady ? (
            <Center>Loading save…</Center>
          ) : (
            <EmulatorView key={`${rom.sha1}:${emuKey}`} rom={rom} save={save ?? undefined} allowStates={ctx.state.settings.saveStates} onReady={onReady} onFrame={(f) => tracker.current?.onFrame(f)}>
              {waiting && (
                <div className="pointer-events-none absolute inset-x-0 top-0 bg-amber-500/90 px-3 py-1.5 text-center text-xs font-bold text-ink-950">
                  ⏸ Waiting for partner — {gate.behind.map(ctx.name).join(', ')} still need badge {gate.gate}
                </div>
              )}
            </EmulatorView>
          )}
          {romMismatch && (
            <div className="absolute right-2 bottom-12 left-2 rounded-xl bg-amber-500/90 px-3 py-1.5 text-center text-xs font-semibold text-ink-950">
              Your ROM's hash differs from the run's. Fine for randomizers — otherwise check you have the same game.{' '}
              <button className="underline" onClick={() => setRom(undefined)}>
                Change ROM
              </button>
            </div>
          )}
        </main>

        {panel && (
          <aside className="flex max-h-[55vh] min-h-0 w-full flex-col border-ink-800 bg-ink-900/95 lg:max-h-none lg:w-[400px] lg:border-l xl:w-[440px]">
            <nav className="flex gap-0.5 overflow-x-auto border-b border-ink-800 p-1.5">
              {TABS.map((t) => (
                <button key={t.id} className={`tab shrink-0 ${tab === t.id ? 'tab-active' : ''}`} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.id === 'feed' && Object.values(ctx.state.disputes).some((d) => d.status === 'open') && <span className="ml-1 text-violet-300">•</span>}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {run.status === 'lobby' && tab === 'team' && <LobbyCard ctx={ctx} />}
              {tab === 'team' && <TeamPanel ctx={ctx} />}
              {tab === 'links' && <LinkBoard ctx={ctx} />}
              {tab === 'feed' && <Feed ctx={ctx} />}
              {tab === 'chat' && <Chat ctx={ctx} />}
              {tab === 'grave' && <Graveyard ctx={ctx} />}
              {tab === 'log' && <ManualPanel ctx={ctx} profile={profile} auto={!!tracker.current?.automatic} />}
              {tab === 'screens' && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-link-b" checked={share} onChange={(e) => setShare(e.target.checked)} />
                    Share my screen with the room
                  </label>
                  <Previews ctx={ctx} on={watch} setOn={setWatch} />
                </div>
              )}
              {tab === 'saves' && (
                <SavesPanel
                  ctx={ctx}
                  onRestore={(data) => {
                    setSave(data);
                    setEmuKey((k) => k + 1);
                  }}
                />
              )}
              {tab === 'rules' && <RulesPanel ctx={ctx} />}
              {tab === 'debug' && <DebugPanel core={handle?.core} tracker={tracker.current} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function LobbyCard({ ctx }: { ctx: RunCtx }) {
  const run = ctx.snap.run!;
  const invite = `${location.origin}/join/${run.inviteCode}`;
  return (
    <div className="mb-5 space-y-3 rounded-2xl border border-link-b/30 bg-link-b/5 p-3">
      <div className="text-sm font-bold">Lobby</div>
      <ul className="space-y-1.5">
        {ctx.snap.players.map((p) => {
          const pr = ctx.snap.presence[p.playerId];
          const match = pr?.romSha1 ? (run.romSha1 ? pr.romSha1 === run.romSha1 : true) : undefined;
          return (
            <li key={p.playerId} className="flex items-center gap-2 text-sm">
              <Avatar name={p.user.name} color={p.color} src={p.user.avatar} size={24} online={pr?.online} />
              <span className="flex-1">{p.user.name}</span>
              <span className={`chip ${match === undefined ? 'bg-ink-700 text-ink-400' : match ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                {match === undefined ? 'no ROM yet' : match ? 'ROM ✓' : 'different ROM'}
              </span>
            </li>
          );
        })}
        {Array.from({ length: run.maxPlayers - ctx.snap.players.length }, (_, i) => (
          <li key={i} className="text-sm text-ink-500">
            Open slot — share the invite link
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button className="btn-secondary flex-1 py-1.5 text-xs" onClick={() => navigator.clipboard.writeText(invite)}>
          Copy invite link
        </button>
        {ctx.isOwner && (
          <button className="btn-primary flex-1 py-1.5 text-xs" onClick={() => api(`/api/runs/${run.id}`, { method: 'PATCH', body: { status: 'active' } })}>
            Start the run
          </button>
        )}
      </div>
    </div>
  );
}

async function downscale(dataUrl: string, width: number): Promise<string | undefined> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => undefined);
  if (!img.width) return undefined;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((img.height / img.width) * width);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}
