/**
 * Run a real track through the real analysis code, offline and deterministically.
 *
 *   node tools/analyse-track.mjs audio/je-te-laisserai-des-mots.mp3
 *
 * The browser was the wrong place to validate this. A trace needs continuous
 * playback for the running ceilings to calibrate, which means holding a tab
 * alive for the length of the track, and any interruption loses the run. This
 * reproduces what the AnalyserNodes feed `MusicAnalysis` - same FFT sizes, same
 * Blackman window, same dB mapping, same smoothing - and runs faster than real
 * time with repeatable results.
 *
 * Needs ffmpeg on PATH to decode.
 */
import { execFileSync } from 'node:child_process';
import { MusicAnalysis } from '../src/analysis.js';

const SAMPLE_RATE = 44100;
const HOP = Math.round(SAMPLE_RATE / 60);

// --- minimal radix-2 FFT ----------------------------------------------------

function fftMagnitudes(re, im, out) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n;
}

/** Mirrors AnalyserNode: Blackman window, temporal smoothing, dB -> byte. */
class ByteAnalyser {
  constructor(fftSize, { smoothing = 0.5, minDb = -95, maxDb = -12 } = {}) {
    this.size = fftSize;
    this.bins = fftSize / 2;
    this.smoothing = smoothing;
    this.minDb = minDb;
    this.maxDb = maxDb;
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.mag = new Float64Array(this.bins);
    this.smooth = new Float64Array(this.bins);
    this.bytes = new Uint8Array(this.bins);
    this.window = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const a = (2 * Math.PI * i) / (fftSize - 1);
      this.window[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
    }
  }

  process(signal, start) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const s = start + i;
      this.re[i] = (s < signal.length ? signal[s] : 0) * this.window[i];
      this.im[i] = 0;
    }
    fftMagnitudes(this.re, this.im, this.mag);
    const t = this.smoothing;
    const range = this.maxDb - this.minDb;
    for (let i = 0; i < this.bins; i++) {
      this.smooth[i] = t * this.smooth[i] + (1 - t) * this.mag[i];
      const db = 20 * Math.log10(this.smooth[i] || 1e-12);
      this.bytes[i] = Math.max(0, Math.min(255, Math.round((255 * (db - this.minDb)) / range)));
    }
    return this.bytes;
  }
}

// --- drive ------------------------------------------------------------------

const file = process.argv[2] ?? 'audio/je-te-laisserai-des-mots.mp3';
const pcm = execFileSync('ffmpeg', [
  '-v', 'error', '-i', file, '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-',
], { maxBuffer: 1 << 30 });

const inter = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const frames = inter.length / 2;
const mid = new Float32Array(frames);
const side = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  const l = inter[i * 2];
  const r = inter[i * 2 + 1];
  mid[i] = (l + r) * 0.5;
  side[i] = (l - r) * 0.5;
}
const duration = frames / SAMPLE_RATE;

const chroma = new ByteAnalyser(8192, { smoothing: 0.55, minDb: -100, maxDb: -10 });
const onset = new ByteAnalyser(1024, { smoothing: 0 });
const midAn = new ByteAnalyser(2048, { smoothing: 0.5 });
const sideAn = new ByteAnalyser(2048, { smoothing: 0.5 });

const m = new MusicAnalysis(SAMPLE_RATE);
const dt = 1 / 60;
const rows = [];
for (let start = 0, k = 0; start + 8192 < frames; start += HOP, k++) {
  m.update(dt,
    chroma.process(mid, start),
    onset.process(mid, start),
    midAn.process(mid, start),
    sideAn.process(side, start));
  if (k % 30 === 0) {
    rows.push({
      t: start / SAMPLE_RATE,
      voice: m.voice, vc: m.voiceConfidence, perc: m.percussiveness,
      dens: m.density, lull: m.lull, key: m.keyName, mode: m.mode,
      tempo: m.tempo, tc: m.tempoConfidence,
    });
  }
}

console.log(`\n${file}  ${duration.toFixed(1)}s\n`);
console.log('    t   voice  conf  perc  dens  lull   key            tempo');
for (const r of rows) {
  console.log(
    `${r.t.toFixed(1).padStart(6)} ${r.voice.toFixed(2).padStart(6)} ${r.vc.toFixed(2).padStart(5)} ` +
    `${r.perc.toFixed(2).padStart(5)} ${r.dens.toFixed(2).padStart(5)} ${r.lull.toFixed(2).padStart(5)}   ` +
    `${(r.key || '-').padEnd(13)} ${r.tempo.toFixed(0).padStart(3)}  |${'#'.repeat(Math.round(r.voice * 20))}`);
}

// Ground truth: the vocal passages found earlier by segmenting centre-channel
// energy at the breath gaps.
const SUNG = [[4, 23], [65, 110]];
const sung = rows.filter((r) => SUNG.some(([a, b]) => r.t >= a && r.t <= b));
const inst = rows.filter((r) => r.t > 25 && !SUNG.some(([a, b]) => r.t >= a && r.t <= b));
const mean = (xs, f) => xs.reduce((s, r) => s + f(r), 0) / Math.max(xs.length, 1);
const pct = (xs, f, q) => {
  const v = xs.map(f).sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0;
};
// A sung passage contains the gaps between phrases, where there correctly is
// no voice - so the mean understates it. What matters is how high it gets
// while someone is actually singing, against how high it ever gets otherwise.
console.log(`\n                 mean   p75    p90    max`);
for (const [label, xs] of [['sung passages', sung], ['instrumentals', inst]]) {
  console.log(`${label.padEnd(15)} ${mean(xs, (r) => r.voice).toFixed(2)}  ` +
    `${pct(xs, (r) => r.voice, 0.75).toFixed(2)}   ${pct(xs, (r) => r.voice, 0.90).toFixed(2)}   ` +
    `${pct(xs, (r) => r.voice, 0.999).toFixed(2)}`);
}
const sep = pct(sung, (r) => r.voice, 0.90) / Math.max(pct(inst, (r) => r.voice, 0.90), 1e-6);
console.log(`\np90 separation  ${sep.toFixed(1)}x\n`);
