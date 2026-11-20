import type { Button } from './types';

export type KeyMap = Record<Button, string[]>;

/** Defaults use KeyboardEvent.code so they work on any keyboard layout. */
export const DEFAULT_KEYMAP: KeyMap = {
  a: ['KeyX'],
  b: ['KeyZ'],
  x: ['KeyS'],
  y: ['KeyA'],
  l: ['KeyQ'],
  r: ['KeyW'],
  start: ['Enter'],
  select: ['Backspace', 'ShiftRight'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
};

/** Standard Gamepad API layout (Xbox-style positions; Nintendo A = right face button). */
const PAD_BUTTONS: Partial<Record<number, Button>> = {
  0: 'b', 1: 'a', 2: 'y', 3: 'x', 4: 'l', 5: 'r', 8: 'select', 9: 'start',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

const STORAGE_KEY = 'leelink.keymap';

export function loadKeymap(): KeyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_KEYMAP, ...JSON.parse(raw) };
  } catch {
    /* corrupted settings fall back to defaults */
  }
  return DEFAULT_KEYMAP;
}

export function saveKeymap(map: KeyMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/**
 * Merges keyboard, gamepad and on-screen touch input into one pressed-button set.
 * Hotkeys (fast-forward etc.) are reported separately so they never reach the game.
 */
export class InputManager {
  private keys = new Set<Button>();
  private touch = new Set<Button>();
  private keymap: KeyMap;
  private codeToButton = new Map<string, Button>();
  onHotkey?: (action: 'fastForwardHold' | 'fastForwardRelease' | 'fastForwardToggle' | 'fullscreen') => void;

  constructor() {
    this.keymap = loadKeymap();
    this.rebuild();
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', this.clear);
  }

  setKeymap(map: KeyMap) {
    this.keymap = map;
    saveKeymap(map);
    this.rebuild();
  }

  getKeymap() {
    return this.keymap;
  }

  private rebuild() {
    this.codeToButton.clear();
    for (const [button, codes] of Object.entries(this.keymap) as [Button, string[]][]) {
      for (const c of codes) this.codeToButton.set(c, button);
    }
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private down = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.onHotkey?.('fastForwardHold'); return; }
    if (e.code === 'Tab') { e.preventDefault(); if (!e.repeat) this.onHotkey?.('fastForwardToggle'); return; }
    if (e.code === 'F11' || (e.code === 'KeyF' && e.altKey)) { e.preventDefault(); this.onHotkey?.('fullscreen'); return; }
    const b = this.codeToButton.get(e.code);
    if (b) {
      e.preventDefault();
      this.keys.add(b);
    }
  };

  private up = (e: KeyboardEvent) => {
    if (e.code === 'Space') { this.onHotkey?.('fastForwardRelease'); return; }
    const b = this.codeToButton.get(e.code);
    if (b) this.keys.delete(b);
  };

  private clear = () => {
    this.keys.clear();
    this.touch.clear();
  };

  setTouch(button: Button, down: boolean) {
    if (down) this.touch.add(button);
    else this.touch.delete(button);
  }

  /** Polled once per emulated frame. */
  pressed(): Set<Button> {
    const out = new Set<Button>([...this.keys, ...this.touch]);
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      pad.buttons.forEach((btn, i) => {
        const b = PAD_BUTTONS[i];
        if (b && btn.pressed) out.add(b);
      });
      const [ax, ay] = pad.axes;
      if (ax < -0.5) out.add('left');
      if (ax > 0.5) out.add('right');
      if (ay < -0.5) out.add('up');
      if (ay > 0.5) out.add('down');
    }
    return out;
  }

  dispose() {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.clear);
  }
}
