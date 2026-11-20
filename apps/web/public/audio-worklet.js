// Ring-buffer audio player. Receives interleaved stereo Float32 chunks via port messages.
class LeeLinkAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 16384;
    this.buf = new Float32Array(this.size * 2);
    this.read = 0;
    this.write = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') { this.read = this.write = 0; return; }
      const chunk = e.data;
      const frames = chunk.length >> 1;
      for (let i = 0; i < frames; i++) {
        const w = this.write % this.size;
        this.buf[w * 2] = chunk[i * 2];
        this.buf[w * 2 + 1] = chunk[i * 2 + 1];
        this.write++;
      }
      // Never let latency grow unbounded (e.g. after a hitch): drop the oldest audio.
      if (this.write - this.read > this.size - 1) this.read = this.write - (this.size >> 2);
    };
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    for (let i = 0; i < l.length; i++) {
      if (this.read < this.write) {
        const p = this.read % this.size;
        l[i] = this.buf[p * 2];
        r[i] = this.buf[p * 2 + 1];
        this.read++;
      } else {
        l[i] = r[i] = 0;
      }
    }
    if ((currentFrame & 0x3fff) < l.length) this.port.postMessage(this.write - this.read);
    return true;
  }
}
registerProcessor('leelink-audio', LeeLinkAudio);
