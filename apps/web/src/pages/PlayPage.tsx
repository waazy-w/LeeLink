import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EmulatorView, type EmulatorHandle } from '../ui/EmulatorView';
import { RomPicker } from '../ui/RomPicker';
import { DebugPanel } from '../ui/dashboard/DebugPanel';
import { TrackerSession } from '../tracking/session';
import { registry, useProfilesLoaded } from '../lib/profiles';
import { saveStore, romStore, type StoredRom } from '../storage/db';
import type { TrackerEvent } from '@leelink/shared/tracking/events';
import { speciesName } from '@leelink/shared/data/species';
import { HpBar, Logo, Sprite } from '../ui/common';
import { sha1Hex } from '@leelink/shared/rom/identify';

/** Solo free play: emulator + live tracker readout. Useful for testing profiles. */
export function PlayPage() {
  const ready = useProfilesLoaded();
  const [rom, setRom] = useState<StoredRom>();
  const [save, setSave] = useState<Uint8Array | null>();
  const [handle, setHandle] = useState<EmulatorHandle>();
  const [events, setEvents] = useState<TrackerEvent[]>([]);
  const [, force] = useState(0);
  const tracker = useRef<TrackerSession>(undefined);

  useEffect(() => {
    if (!rom) return;
    setSave(undefined);
    void saveStore.get(rom.sha1).then((s) => setSave(s?.data ?? null));
  }, [rom]);

  const onReady = useCallback(
    (h: EmulatorHandle) => {
      setHandle(h);
      void romStore.put({ ...rom!, lastPlayedAt: Date.now() });
      tracker.current = new TrackerSession(h.core, registry.match(rom!.info)?.profile, {
        onEvents: (e) => setEvents((x) => [...e, ...x].slice(0, 50)),
        onParty: () => undefined,
      });
    },
    [rom],
  );

  // Local save persistence + refresh the party readout.
  useEffect(() => {
    if (!handle || !rom) return;
    let last = '';
    const t = setInterval(async () => {
      force((x) => x + 1);
      const data = handle.core.exportSave();
      if (!data?.length) return;
      const h = await sha1Hex(data);
      if (h !== last) {
        last = h;
        await saveStore.put({ key: rom.sha1, data, updatedAt: Date.now() });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [handle, rom]);

  const st = tracker.current?.lastState;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-800 px-3 py-2">
        <Link to="/">
          <Logo className="text-base" />
        </Link>
        <span className="text-sm text-ink-400">Free play</span>
        <div className="flex-1" />
        {rom && (
          <button className="btn-ghost py-1 text-xs" onClick={() => (setRom(undefined), setHandle(undefined))}>
            Change ROM
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-h-0 min-w-0 flex-1">
          {!rom ? (
            <div className="mx-auto max-w-2xl p-6">
              <RomPicker onPick={setRom} />
            </div>
          ) : save === undefined || !ready ? null : (
            <EmulatorView rom={rom} save={save ?? undefined} allowStates onReady={onReady} onFrame={(f) => tracker.current?.onFrame(f)} />
          )}
        </main>
        {rom && (
          <aside className="max-h-[50vh] w-full space-y-4 overflow-y-auto border-ink-800 p-3 lg:max-h-none lg:w-96 lg:border-l">
            <div className="text-xs font-bold tracking-widest text-ink-400 uppercase">Party (read from memory)</div>
            {st?.inGame ? (
              <div className="space-y-1.5">
                {st.party.map((s) =>
                  s.mon ? (
                    <div key={s.slot} className="flex items-center gap-2 rounded-xl bg-ink-800 p-2">
                      <Sprite species={s.mon.species} size={40} />
                      <div className="flex-1">
                        <div className="text-sm font-semibold">
                          {s.mon.nickname || speciesName(s.mon.species)} <span className="font-mono text-xs text-ink-400">Lv{s.mon.level}</span>
                        </div>
                        <HpBar hp={s.mon.hp} maxHp={s.mon.maxHp} />
                        <div className="text-[11px] text-ink-400">
                          {s.mon.hp}/{s.mon.maxHp} HP · {s.mon.status}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={s.slot} className="text-xs text-amber-300">
                      slot {s.slot}: {s.error}
                    </div>
                  ),
                )}
                <div className="text-xs text-ink-400">
                  📍 {st.location.name} · 🏅 {st.badges.filter(Boolean).length} {st.battle.active && `· ⚔ ${st.battle.kind} battle`}
                </div>
              </div>
            ) : (
              <div className="text-sm text-ink-400">{tracker.current?.automatic ? 'Waiting for the game to load a save…' : 'No profile for this game — manual mode.'}</div>
            )}
            <div className="text-xs font-bold tracking-widest text-ink-400 uppercase">Detected events</div>
            <ul className="space-y-0.5 font-mono text-[11px] text-ink-300">
              {events.map((e, i) => (
                <li key={i}>
                  {e.type} {'species' in e ? speciesName(e.species) : 'mon' in e ? speciesName(e.mon.species) : ''} {'place' in e ? `@ ${e.place.area}` : ''}
                </li>
              ))}
            </ul>
            <DebugPanel core={handle?.core} tracker={tracker.current} />
          </aside>
        )}
      </div>
    </div>
  );
}
