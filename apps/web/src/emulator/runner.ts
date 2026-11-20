import type { EmulatorCore } from './types';

export interface RunnerOptions {
  /** One canvas per screen. */
  canvases: HTMLCanvasElement[];
  /** Called after each emulated frame (used by the tracker to sample memory). */
  onFrame?: (frameNumber: number) => void;
}

/**
 * Drives a core at its native rate from requestAnimationFrame, handles fast-forward,
 * and streams audio to an AudioWorklet.
 */
export class Runner {
  private raf = 0;
  private last = 0;
  private debt = 0;
  private frame = 0;
  private audio?: AudioContext;
  private node?: AudioWorkletNode;
  private images: ImageData[] = [];
  private ctxs: CanvasRenderingContext2D[] = [];
  speed = 1;
  paused = false;
  muted = false;
  volume = 0.8;
  private gain?: GainNode;

  constructor(readonly core: EmulatorCore, private readonly opts: RunnerOptions) {
    this.ctxs = opts.canvases.map((c) => c.getContext('2d', { alpha: false })!);
    this.resizeCanvases();
  }

  private resizeCanvases() {
    const screens = this.core.screens();
    this.images = screens.map((s, i) => {
      const c = this.opts.canvases[i];
      if (c && (c.width !== s.width || c.height !== s.height)) {
        c.width = s.width;
        c.height = s.height;
      }
      return new ImageData(s.width, s.height);
    });
  }

  /** Must be called from a user gesture at least once for audio to start. */
  async enableAudio() {
    if (this.audio) {
      await this.audio.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-worklet.js`);
    const node = new AudioWorkletNode(ctx, 'leelink-audio', { outputChannelCount: [2] });
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    node.connect(gain).connect(ctx.destination);
    this.core.setAudioRate(ctx.sampleRate);
    this.audio = ctx;
    this.node = node;
    this.gain = gain;
  }

  setVolume(volume: number, muted: boolean) {
    this.volume = volume;
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : volume;
  }

  start() {
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(now - this.last, 100); // don't try to catch up after a tab switch
      this.last = now;
      if (this.paused) return;
      this.debt += (dt / 1000) * this.core.fps * this.speed;
      const maxFrames = Math.max(4, Math.ceil(this.speed * 4));
      let ran = 0;
      while (this.debt >= 1 && ran < maxFrames) {
        this.core.runFrame();
        this.debt -= 1;
        ran++;
        this.frame++;
        this.pumpAudio(ran);
        this.opts.onFrame?.(this.frame);
      }
      if (ran) this.draw();
      if (this.debt > maxFrames) this.debt = 0;
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pumpAudio(nthThisTick: number) {
    const samples = this.core.drainAudio();
    // While fast-forwarding, only play one frame of audio per tick to keep it intelligible.
    if (!this.node || (this.speed > 1 && nthThisTick > 1)) return;
    const f = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f[i] = samples[i] / 32768;
    this.node.port.postMessage(f, [f.buffer]);
  }

  draw() {
    const screens = this.core.screens();
    if (screens.length !== this.images.length || screens.some((s, i) => s.width !== this.images[i].width || s.height !== this.images[i].height)) {
      this.resizeCanvases();
    }
    this.images.forEach((img, i) => {
      this.core.readVideo(i, img.data);
      this.ctxs[i]?.putImageData(img, 0, 0);
    });
  }

  /** Current frame of a screen as a small JPEG data URL (for live previews). */
  snapshot(screen = 0, quality = 0.5): string | undefined {
    return this.opts.canvases[screen]?.toDataURL('image/jpeg', quality);
  }

  get frameNumber() {
    return this.frame;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.node?.port.postMessage('clear');
    void this.audio?.close();
    this.audio = undefined;
    this.node = undefined;
  }
}
