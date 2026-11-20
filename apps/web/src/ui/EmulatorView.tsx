import { useEffect, useRef, useState } from 'react';
import type { StoredRom } from '../storage/db';
import { createCore } from '../emulator/load';
import { Runner } from '../emulator/runner';
import { InputManager, DEFAULT_KEYMAP, type KeyMap } from '../emulator/input';
import type { Button, EmulatorCore } from '../emulator/types';
import { TouchControls } from './TouchControls';

export interface EmulatorHandle {
  core: EmulatorCore;
  runner: Runner;
}

interface Props {
  rom: StoredRom;
  save?: Uint8Array;
  allowStates: boolean;
  onReady?: (h: EmulatorHandle) => void;
  onFrame?: (frame: number) => void;
  /** Overlays rendered on top of the screen (alerts, pacing banner). */
  children?: React.ReactNode;
}

const SPEEDS = [1, 2, 4, 8];

export function EmulatorView({ rom, save, allowStates, onReady, onFrame, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const bottom = useRef<HTMLCanvasElement>(null);
  const [handle, setHandle] = useState<EmulatorHandle>();
  const [error, setError] = useState<string>();
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(() => localStorage.getItem('leelink.muted') === '1');
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('leelink.volume') ?? 0.8));
  const [showKeys, setShowKeys] = useState(false);
  const [touch, setTouch] = useState(() => matchMedia('(pointer: coarse)').matches);
  const input = useRef<InputManager>(undefined);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const isDs = rom.info.platform === 'nds';

  useEffect(() => {
    let disposed = false;
    let runner: Runner | undefined;
    let core: EmulatorCore | undefined;
    const im = new InputManager();
    input.current = im;
    (async () => {
      try {
        core = await createCore(rom.info, rom.data, save);
        if (disposed) return core.dispose();
        const canvases = [top.current!, ...(isDs ? [bottom.current!] : [])];
        runner = new Runner(core, {
          canvases,
          onFrame: (f) => {
            core!.setButtons(im.pressed());
            onFrameRef.current?.(f);
          },
        });
        runner.setVolume(volume, muted);
        runner.start();
        const h = { core, runner };
        setHandle(h);
        onReady?.(h);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      disposed = true;
      runner?.stop();
      core?.dispose();
      im.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rom.sha1]);

  // Hotkeys.
  useEffect(() => {
    const im = input.current;
    if (!im || !handle) return;
    im.onHotkey = (a) => {
      if (a === 'fastForwardHold') handle.runner.speed = 4;
      if (a === 'fastForwardRelease') handle.runner.speed = speed;
      if (a === 'fastForwardToggle') setSpeed((s) => (s === 1 ? 4 : 1));
      if (a === 'fullscreen') toggleFullscreen();
    };
  }, [handle, speed]);

  useEffect(() => {
    if (handle) handle.runner.speed = speed;
  }, [handle, speed]);
  useEffect(() => {
    if (handle) handle.runner.paused = paused;
  }, [handle, paused]);
  useEffect(() => {
    handle?.runner.setVolume(volume, muted);
    localStorage.setItem('leelink.muted', muted ? '1' : '0');
    localStorage.setItem('leelink.volume', String(volume));
  }, [handle, volume, muted]);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.();
  }

  async function start() {
    setStarted(true);
    await handle?.runner.enableAudio();
  }

  // DS touch screen: map pointer position to 256x192 bottom-screen pixels.
  function touchHandlers() {
    if (!isDs) return {};
    const send = (e: React.PointerEvent<HTMLCanvasElement>, down: boolean) => {
      const r = e.currentTarget.getBoundingClientRect();
      handle?.core.touch?.(((e.clientX - r.left) / r.width) * 256, ((e.clientY - r.top) / r.height) * 192, down);
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        send(e, true);
      },
      onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => e.buttons && send(e, true),
      onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => send(e, false),
      onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => send(e, false),
    };
  }

  const [stateSlot, setStateSlot] = useState<Uint8Array>();

  return (
    <div ref={wrap} className="relative flex h-full w-full flex-col bg-ink-950">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <div className={`relative flex max-h-full max-w-full ${isDs ? 'aspect-[256/384] h-full flex-col' : `${rom.info.platform === 'gba' ? 'aspect-[3/2]' : 'aspect-[10/9]'} w-full`}`} style={isDs ? undefined : { maxHeight: '100%' }}>
          <canvas ref={top} className={`pixelated block w-full ${isDs ? 'h-1/2' : 'h-full'} bg-black object-contain`} />
          {isDs && <canvas ref={bottom} className="pixelated block h-1/2 w-full touch-none bg-black" {...touchHandlers()} />}
          {children}
        </div>
        {!started && !error && (
          <button onClick={start} className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/80 backdrop-blur-sm">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-link-a text-3xl shadow-2xl shadow-link-a/40 animate-pulse-ring">▶</span>
            <span className="text-sm font-semibold text-ink-200">{handle ? 'Click to start (enables sound)' : 'Loading emulator…'}</span>
          </button>
        )}
        {error && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-rose-300">{error}</div>}
      </div>

      {touch && handle && <TouchControls ds={isDs} onButton={(b: Button, d: boolean) => input.current?.setTouch(b, d)} />}

      <div className="flex flex-wrap items-center gap-1 border-t border-ink-800 bg-ink-900/90 px-2 py-1.5 text-xs">
        <button className="btn-ghost px-2 py-1" onClick={() => setPaused((p) => !p)} title="Pause">
          {paused ? '▶' : '❚❚'}
        </button>
        <div className="flex rounded-lg bg-ink-800 p-0.5" title="Fast-forward (Tab toggles, hold Space)">
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => setSpeed(s)} className={`rounded-md px-2 py-0.5 font-mono ${speed === s ? 'bg-link-b text-ink-950' : 'text-ink-300'}`}>
              {s}×
            </button>
          ))}
        </div>
        <button className="btn-ghost px-2 py-1" onClick={() => setMuted((m) => !m)} title="Mute">
          {muted ? '🔇' : '🔊'}
        </button>
        <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-20 accent-link-b" aria-label="Volume" />
        {allowStates && handle && (
          <>
            <button className="btn-ghost px-2 py-1" onClick={() => setStateSlot(handle.core.saveState())}>
              Save state
            </button>
            <button className="btn-ghost px-2 py-1" disabled={!stateSlot} onClick={() => stateSlot && handle.core.loadState(stateSlot)}>
              Load state
            </button>
          </>
        )}
        <div className="flex-1" />
        <button className="btn-ghost px-2 py-1" onClick={() => setTouch((t) => !t)} title="On-screen controls">
          🎮
        </button>
        <button className="btn-ghost px-2 py-1" onClick={() => setShowKeys(true)} title="Controls">
          ⌨
        </button>
        <button className="btn-ghost px-2 py-1" onClick={toggleFullscreen} title="Fullscreen (Alt+F)">
          ⛶
        </button>
      </div>
      {showKeys && input.current && <KeymapDialog input={input.current} ds={isDs} onClose={() => setShowKeys(false)} />}
    </div>
  );
}

function KeymapDialog({ input, ds, onClose }: { input: InputManager; ds: boolean; onClose: () => void }) {
  const [map, setMap] = useState<KeyMap>(input.getKeymap());
  const [listening, setListening] = useState<Button>();
  const buttons: Button[] = ['up', 'down', 'left', 'right', 'a', 'b', ...(ds ? (['x', 'y'] as Button[]) : []), 'l', 'r', 'start', 'select'];

  useEffect(() => {
    if (!listening) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const next = { ...map, [listening]: [e.code] };
      setMap(next);
      input.setKeymap(next);
      setListening(undefined);
    };
    window.addEventListener('keydown', h, { capture: true, once: true });
    return () => window.removeEventListener('keydown', h, { capture: true });
  }, [listening, map, input]);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/80 p-4" onClick={onClose}>
      <div className="panel w-full max-w-sm space-y-3 p-4 animate-pop" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold">Controls</h3>
        <div className="grid grid-cols-2 gap-2">
          {buttons.map((b) => (
            <button key={b} onClick={() => setListening(b)} className={`flex items-center justify-between rounded-lg border px-3 py-1.5 text-sm ${listening === b ? 'border-link-b' : 'border-ink-700'}`}>
              <span className="font-semibold uppercase">{b}</span>
              <span className="font-mono text-xs text-ink-300">{listening === b ? 'press a key…' : map[b].join(', ').replace(/Key|Arrow/g, '')}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-400">Space: hold fast-forward · Tab: toggle fast-forward · Alt+F: fullscreen. Gamepads work automatically.</p>
        <div className="flex justify-between">
          <button
            className="btn-ghost"
            onClick={() => {
              setMap(DEFAULT_KEYMAP);
              input.setKeymap(DEFAULT_KEYMAP);
            }}
          >
            Reset
          </button>
          <button className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
