/**
 * Tiny synthesized sound effects via the Web Audio API. No audio files, no
 * network. Disabled by default; every sound is very quiet and rate-limited so
 * the companion never becomes noisy.
 */
export type SoundKind = "purr" | "land" | "meow" | "sleep";

const MIN_GAP_MS: Record<SoundKind, number> = {
  purr: 1600,
  land: 200,
  meow: 1200,
  sleep: 4000,
};

export class SoundManager {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private lastPlayed: Record<SoundKind, number> = { purr: 0, land: 0, meow: 0, sleep: 0 };

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.ctx) {
      try {
        this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      } catch {
        this.ctx = null;
      }
    }
  }

  play(kind: SoundKind): void {
    if (!this.enabled || !this.ctx) return;
    const now = performance.now();
    if (now - this.lastPlayed[kind] < MIN_GAP_MS[kind]) return;
    this.lastPlayed[kind] = now;
    try {
      switch (kind) {
        case "purr":
          this.tone(55, 0.6, "sine", 0.03, 12);
          break;
        case "land":
          this.tone(140, 0.08, "triangle", 0.05);
          break;
        case "meow":
          this.glide(520, 380, 0.22, 0.04);
          break;
        case "sleep":
          this.tone(220, 0.5, "sine", 0.02);
          break;
      }
    } catch {
      /* ignore audio failures */
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, gainPeak: number, tremolo = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(gainPeak, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    if (tremolo > 0) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = tremolo;
      lfoGain.gain.value = gainPeak * 0.5;
      lfo.connect(lfoGain).connect(gain.gain);
      lfo.start();
      lfo.stop(ctx.currentTime + dur);
    }
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }

  private glide(from: number, to: number, dur: number, gainPeak: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(to, ctx.currentTime + dur);
    gain.gain.setValueAtTime(gainPeak, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }
}
