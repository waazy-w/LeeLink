import type { Button } from '../emulator/types';

/** On-screen controls for phones. Multi-touch: each button tracks its own pointer. */
export function TouchControls({ onButton, ds }: { onButton: (b: Button, down: boolean) => void; ds: boolean }) {
  const btn = (b: Button, label: string, cls: string) => (
    <button
      key={b}
      className={`touch-none select-none rounded-full bg-ink-700/80 font-bold text-ink-100 active:bg-link-b active:text-ink-950 ${cls}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        navigator.vibrate?.(8);
        onButton(b, true);
      }}
      onPointerUp={() => onButton(b, false)}
      onPointerCancel={() => onButton(b, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-t border-ink-800 bg-ink-900 px-4 py-3 select-none">
      <div className="grid grid-cols-3 grid-rows-3 gap-1">
        <span />
        {btn('up', '▲', 'h-12 w-12 rounded-lg')}
        <span />
        {btn('left', '◀', 'h-12 w-12 rounded-lg')}
        <span />
        {btn('right', '▶', 'h-12 w-12 rounded-lg')}
        <span />
        {btn('down', '▼', 'h-12 w-12 rounded-lg')}
        <span />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="flex gap-2">
          {btn('l', 'L', 'h-8 w-14 rounded-lg text-xs')}
          {btn('r', 'R', 'h-8 w-14 rounded-lg text-xs')}
        </div>
        <div className="flex gap-2">
          {btn('select', 'SELECT', 'h-7 px-3 text-[10px]')}
          {btn('start', 'START', 'h-7 px-3 text-[10px]')}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ds ? (
          <>
            {btn('x', 'X', 'h-12 w-12')}
            {btn('a', 'A', 'h-12 w-12 bg-link-a/80')}
            {btn('y', 'Y', 'h-12 w-12')}
            {btn('b', 'B', 'h-12 w-12')}
          </>
        ) : (
          <>
            <span />
            {btn('a', 'A', 'h-14 w-14 bg-link-a/80')}
            {btn('b', 'B', 'h-14 w-14')}
            <span />
          </>
        )}
      </div>
    </div>
  );
}
