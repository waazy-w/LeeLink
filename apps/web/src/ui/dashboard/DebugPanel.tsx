import { useEffect, useState } from 'react';
import type { EmulatorCore } from '../../emulator/types';
import type { TrackerSession } from '../../tracking/session';
import { encodeSnapshot, takeSnapshot } from '@leelink/shared/memory/reader';
import { Section } from '../common';

const hex = (n: number, w = 8) => n.toString(16).toUpperCase().padStart(w, '0');

/**
 * Developer view for building ROM hack profiles: live game state, a hex viewer and a
 * RAM search (find addresses by repeatedly narrowing on a known value).
 */
export function DebugPanel({ core, tracker }: { core?: EmulatorCore; tracker?: TrackerSession }) {
  const [tick, setTick] = useState(0);
  const [addr, setAddr] = useState('02024284');
  const [label, setLabel] = useState('');
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!core) return <div className="text-sm text-ink-400">Start the game to inspect memory.</div>;

  const base = parseInt(addr, 16) || 0;
  const rows = Array.from({ length: 8 }, (_, r) => {
    const a = base + r * 16;
    const bytes = core.memory.readBytes(a, 16);
    return { a, bytes };
  });
  const state = tracker?.lastState;

  function exportSnapshot() {
    const snap = takeSnapshot(core!.platform, core!.regions(), label || undefined, tracker?.profile?.match.gameCodes?.[0]);
    const blob = new Blob([encodeSnapshot(snap) as BlobPart], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(label || 'snapshot').replace(/\W+/g, '-')}.llsnap`;
    a.click();
  }

  return (
    <div className="space-y-5" data-tick={tick}>
      <Section title="Profile">
        <div className="text-sm">{tracker?.profile ? `${tracker.profile.name} (${tracker.profile.id})` : 'No profile — manual mode'}</div>
        {tracker && tracker.errors > 0 && <div className="text-xs text-rose-300">{tracker.errors} read errors — check the profile addresses.</div>}
      </Section>
      {state && (
        <Section title="Decoded game state">
          <pre className="max-h-64 overflow-auto rounded-xl bg-ink-950 p-2 font-mono text-[10px] leading-snug text-ink-300">
            {JSON.stringify({ ...state, party: state.party.map((s) => s.mon ? `${s.mon.species} ${s.mon.nickname} Lv${s.mon.level} ${s.mon.hp}/${s.mon.maxHp}` : s.error), boxes: state.boxes?.length }, null, 1)}
          </pre>
        </Section>
      )}
      <Section title="Memory">
        <input className="input font-mono" value={addr} onChange={(e) => setAddr(e.target.value.replace(/[^0-9a-fA-F]/g, ''))} />
        <pre className="overflow-x-auto rounded-xl bg-ink-950 p-2 font-mono text-[10px] leading-relaxed">
          {rows.map(({ a, bytes }) => (
            <div key={a}>
              <span className="text-ink-500">{hex(a)}</span> {[...bytes].map((b) => hex(b, 2)).join(' ')}{' '}
              <span className="text-ink-500">{[...bytes].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}</span>
            </div>
          ))}
        </pre>
      </Section>
      <RamSearch core={core} onPick={(a) => setAddr(hex(a))} />
      <Section title="Snapshot">
        <p className="text-xs text-ink-400">Exports the game's RAM as a .llsnap test fixture (for profile tests).</p>
        <div className="flex gap-2">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. wild battle Route 3" />
          <button className="btn-secondary" onClick={exportSnapshot}>
            Export
          </button>
        </div>
      </Section>
    </div>
  );
}

function RamSearch({ core, onPick }: { core: EmulatorCore; onPick: (a: number) => void }) {
  const [width, setWidth] = useState<1 | 2 | 4>(1);
  const [value, setValue] = useState('');
  const [cands, setCands] = useState<number[] | null>(null);

  const read = (a: number) => (width === 1 ? core.memory.read8(a) : width === 2 ? core.memory.read16(a) : core.memory.read32(a));

  function search(mode: 'eq' | 'changed' | 'same') {
    const v = Number(value);
    const test = (a: number, prev?: number) => (mode === 'eq' ? read(a) === v : mode === 'changed' ? read(a) !== prev : read(a) === prev);
    if (!cands) {
      const out: number[] = [];
      for (const r of core.regions()) {
        const bytes = r.bytes();
        for (let i = 0; i + width <= bytes.length; i += width) {
          const a = r.base + i;
          if (mode === 'eq' && test(a)) out.push(a);
        }
      }
      setCands(out);
      prevVals.current = new Map(out.map((a) => [a, read(a)]));
    } else {
      const next = cands.filter((a) => test(a, prevVals.current.get(a)));
      prevVals.current = new Map(next.map((a) => [a, read(a)]));
      setCands(next);
    }
  }
  const prevVals = useStateRef(new Map<number, number>());

  return (
    <Section title="RAM search">
      <p className="text-xs text-ink-400">Find an address: search for a value you can see in-game (e.g. a level), change it in-game, search again.</p>
      <div className="flex gap-2">
        <select className="input w-24 py-1" value={width} onChange={(e) => (setWidth(Number(e.target.value) as 1 | 2 | 4), setCands(null))}>
          <option value={1}>8-bit</option>
          <option value={2}>16-bit</option>
          <option value={4}>32-bit</option>
        </select>
        <input className="input py-1" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
      </div>
      <div className="flex flex-wrap gap-1">
        <button className="btn-secondary py-1 text-xs" onClick={() => search('eq')}>
          {cands ? 'Equals' : 'Search'}
        </button>
        {cands && (
          <>
            <button className="btn-secondary py-1 text-xs" onClick={() => search('changed')}>
              Changed
            </button>
            <button className="btn-secondary py-1 text-xs" onClick={() => search('same')}>
              Unchanged
            </button>
            <button className="btn-ghost py-1 text-xs" onClick={() => setCands(null)}>
              Reset
            </button>
          </>
        )}
      </div>
      {cands && (
        <div className="text-xs text-ink-400">
          {cands.length} candidates
          <div className="mt-1 flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {cands.slice(0, 60).map((a) => (
              <button key={a} className="rounded bg-ink-800 px-1.5 font-mono text-[10px] hover:bg-ink-700" onClick={() => onPick(a)}>
                {hex(a)}={read(a)}
              </button>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function useStateRef<T>(initial: T) {
  const [ref] = useState(() => ({ current: initial }));
  return ref;
}
