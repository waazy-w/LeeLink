import { useEffect, useRef, useState } from 'react';
import { identifyRom } from '@leelink/shared/rom/identify';
import { romStore, type StoredRom } from '../storage/db';
import { registry } from '../lib/profiles';
import { timeAgo } from './common';

const PLATFORM_LABEL = { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'GBA', nds: 'DS' } as const;

/**
 * Lets the player pick a ROM from their own device. The file is hashed and cached in
 * IndexedDB in this browser only; it is never uploaded.
 */
export function RomPicker({ onPick, expectSha1, compact }: { onPick: (rom: StoredRom) => void; expectSha1?: string; compact?: boolean }) {
  const [roms, setRoms] = useState<StoredRom[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => romStore.list().then((r) => setRoms(r.sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt))));
  useEffect(() => {
    void refresh();
  }, []);

  async function addFile(file: File) {
    setError(undefined);
    setBusy(true);
    try {
      let data = new Uint8Array(await file.arrayBuffer());
      if (file.name.toLowerCase().endsWith('.zip')) throw new Error('Unzip the ROM first, then pick the .gba / .gbc / .nds file.');
      const info = await identifyRom(data);
      if (!info) throw new Error("That doesn't look like a GB, GBC, GBA or DS ROM.");
      const rom: StoredRom = { sha1: info.sha1, info, fileName: file.name, data, addedAt: Date.now() };
      await romStore.put(rom);
      data = new Uint8Array(0);
      await refresh();
      onPick(rom);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) void addFile(f);
        }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-6 text-center transition ${drag ? 'border-link-b bg-link-b/10' : 'border-ink-600 hover:border-ink-400'}`}
      >
        <input ref={input} type="file" accept=".gba,.gbc,.gb,.nds" className="hidden" onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} />
        <div className="text-sm font-semibold">{busy ? 'Reading ROM…' : 'Choose a ROM from your device'}</div>
        <div className="mt-1 text-xs text-ink-400">.gb · .gbc · .gba · .nds — stays in this browser, never uploaded</div>
      </div>
      {error && <div className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>}
      {roms.length > 0 && (
        <div className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
          {roms.map((r) => {
            const match = registry.match(r.info);
            const mismatch = expectSha1 && r.sha1 !== expectSha1;
            return (
              <div key={r.sha1} className={`group flex items-center gap-3 rounded-xl border p-3 transition ${mismatch ? 'border-ink-700 opacity-60' : 'border-ink-700 hover:border-link-b'}`}>
                <button className="min-w-0 flex-1 text-left" onClick={() => onPick(r)}>
                  <div className="truncate text-sm font-semibold">{match?.profile.name ?? r.info.title}</div>
                  <div className="truncate text-xs text-ink-400">
                    {PLATFORM_LABEL[r.info.platform]} · {r.fileName} · {r.lastPlayedAt ? `played ${timeAgo(r.lastPlayedAt)}` : 'never played'}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {match ? (
                      <span className="chip bg-emerald-500/15 text-emerald-300">{match.confidence === 'exact' ? 'Auto-tracking' : 'Auto-tracking (by game code)'}</span>
                    ) : (
                      <span className="chip bg-ink-700 text-ink-300">Manual mode</span>
                    )}
                    {expectSha1 && <span className={`chip ${mismatch ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{mismatch ? 'Different ROM than the run' : 'Matches the run'}</span>}
                  </div>
                </button>
                <button
                  className="btn-ghost px-2 py-1 text-xs opacity-0 group-hover:opacity-100"
                  title="Forget this ROM"
                  onClick={async () => {
                    await romStore.remove(r.sha1);
                    void refresh();
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
