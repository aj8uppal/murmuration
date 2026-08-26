/**
 * Audio engine: file playback, microphone input, and a built-in generative
 * ambient piece. Everything funnels through one analyser so the visualiser
 * never has to care where the sound came from.
 */

import { MusicAnalysis } from './analysis.js';

const BINS = 128;
const F_MIN = 28;
const F_MAX = 16000;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.mode = 'none';           // 'file' | 'mic' | 'ambient'
    this.trackName = '';
    this.duration = 0;
    this.playing = false;

    this.spectrum = new Float32Array(BINS);
    this.prevSpectrum = new Float32Array(BINS);
    this.bass = 0;
    this.lowMid = 0;
    this.mid = 0;
    this.high = 0;
    this.level = 0;
    this.flux = 0;
    this.beat = 0;
    this.beatAge = 10;

    this.bassHistory = new Float32Array(48);
    this.bassIndex = 0;
    this.lastBeatAt = -10;

    this.buffer = null;
    this.startedAt = 0;
    this.offset = 0;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.72;
      this.analyser.minDecibels = -96;
      this.analyser.maxDecibels = -14;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      // Key wants fine frequency resolution, onsets want fine time resolution,
      // so they get their own windows rather than compromising on one.
      this.chromaAnalyser = this.ctx.createAnalyser();
      this.chromaAnalyser.fftSize = 8192;
      this.chromaAnalyser.smoothingTimeConstant = 0.55;
      this.chromaAnalyser.minDecibels = -100;
      this.chromaAnalyser.maxDecibels = -10;
      this.chromaData = new Uint8Array(this.chromaAnalyser.frequencyBinCount);

      this.onsetAnalyser = this.ctx.createAnalyser();
      this.onsetAnalyser.fftSize = 1024;
      this.onsetAnalyser.smoothingTimeConstant = 0;
      this.onsetAnalyser.minDecibels = -95;
      this.onsetAnalyser.maxDecibels = -12;
      this.onsetData = new Uint8Array(this.onsetAnalyser.frequencyBinCount);

      // Mid and side. A vocal is mixed dead centre and a piano or a string
      // section is spread wide, so (L+R) against (L-R) separates the voice from
      // the arrangement far better than any frequency split can - they share
      // the same octaves. Mid is just the tap down-mixed to mono; side needs
      // the right channel inverted and summed back onto the left.
      this.midAnalyser = this.ctx.createAnalyser();
      this.sideAnalyser = this.ctx.createAnalyser();
      for (const a of [this.midAnalyser, this.sideAnalyser]) {
        a.fftSize = 2048;
        a.smoothingTimeConstant = 0.5;
        a.minDecibels = -95;
        a.maxDecibels = -12;
      }
      this.midData = new Uint8Array(this.midAnalyser.frequencyBinCount);
      this.sideData = new Uint8Array(this.sideAnalyser.frequencyBinCount);

      // Analysis bus. Nothing downstream of it reaches the speakers, so
      // microphone input can be measured without being played back.
      this.tap = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.master.connect(this.tap);
      this.tap.connect(this.analyser);
      this.tap.connect(this.chromaAnalyser);
      this.tap.connect(this.onsetAnalyser);
      this.tap.connect(this.midAnalyser);

      const splitter = this.ctx.createChannelSplitter(2);
      const invertRight = this.ctx.createGain();
      invertRight.gain.value = -1;
      this.sideSum = this.ctx.createGain();
      this.tap.connect(splitter);
      splitter.connect(this.sideSum, 0);
      splitter.connect(invertRight, 1);
      invertRight.connect(this.sideSum);
      this.sideSum.connect(this.sideAnalyser);

      this.music = new MusicAnalysis(this.ctx.sampleRate);
      this.#buildBinMap();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  #buildBinMap() {
    const nyquist = this.ctx.sampleRate / 2;
    const n = this.analyser.frequencyBinCount;
    this.binRanges = [];
    let prev = 0;
    for (let k = 0; k < BINS; k++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, (k + 1) / BINS);
      const hi = Math.min(n - 1, Math.max(prev + 1, Math.round((f / nyquist) * n)));
      this.binRanges.push([prev, hi]);
      prev = hi;
    }
  }

  #stopSource() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    if (this.ambient) { this.ambient.stop(); this.ambient = null; }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.playing = false;
  }

  async playFile(file) {
    await this.ensureContext();
    this.#stopSource();
    await this.#useBuffer(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
  }

  /** Loads a track shipped with the app. */
  async playUrl(url, name) {
    await this.ensureContext();
    this.#stopSource();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not load the track (${res.status})`);
    await this.#useBuffer(await res.arrayBuffer(), name);
  }

  async #useBuffer(data, name) {
    this.buffer = await this.ctx.decodeAudioData(data);
    this.duration = this.buffer.duration;
    this.trackName = name;
    this.mode = 'file';
    this.offset = 0;
    this.#startBuffer(0);
  }

  #startBuffer(offset) {
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.loop = true;
    this.source.connect(this.master);
    this.source.start(0, offset % this.buffer.duration);
    this.startedAt = this.ctx.currentTime;
    this.offset = offset;
    this.playing = true;
  }

  async startAmbient() {
    await this.ensureContext();
    this.#stopSource();
    this.ambient = new AmbientPiece(this.ctx, this.master);
    this.ambient.start();
    this.mode = 'ambient';
    this.trackName = 'nocturne · generative';
    this.duration = 0;
    this.playing = true;
  }

  async startMic() {
    await this.ensureContext();
    this.#stopSource();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.source = this.ctx.createMediaStreamSource(this.micStream);
    // Onto the analysis bus only, never back out to the speakers.
    this.source.connect(this.tap);
    this.mode = 'mic';
    this.trackName = 'live input';
    this.duration = 0;
    this.playing = true;
  }

  togglePlay() {
    if (!this.ctx) return;
    if (this.ctx.state === 'running') { this.ctx.suspend(); this.playing = false; }
    else { this.ctx.resume(); this.playing = true; }
  }

  get currentTime() {
    if (this.mode !== 'file' || !this.buffer) return 0;
    return (this.offset + (this.ctx.currentTime - this.startedAt)) % this.buffer.duration;
  }

  seek(fraction) {
    if (this.mode !== 'file' || !this.buffer) return;
    const t = Math.max(0, Math.min(0.999, fraction)) * this.buffer.duration;
    try { this.source.stop(); } catch { /* noop */ }
    this.source.disconnect();
    this.#startBuffer(t);
  }

  /** Pulls a frame of analysis. Safe to call before any audio exists. */
  analyse(dt) {
    this.beatAge += dt;
    if (!this.analyser) {
      this.#decayIdle(dt);
      return;
    }

    this.analyser.getByteFrequencyData(this.freqData);
    const data = this.freqData;

    let flux = 0;
    for (let k = 0; k < BINS; k++) {
      const [lo, hi] = this.binRanges[k];
      let peak = 0;
      for (let i = lo; i < hi; i++) if (data[i] > peak) peak = data[i];
      const v = peak / 255;

      // Slight low-end rolloff compensation so the top octaves stay visible.
      const tilt = 0.55 + 0.45 * Math.pow(k / (BINS - 1), 0.45);
      const target = v * tilt;

      this.prevSpectrum[k] = this.spectrum[k];
      // Fast attack, slow release keeps transients crisp without flicker.
      const a = target > this.spectrum[k] ? 0.55 : 0.10;
      this.spectrum[k] += (target - this.spectrum[k]) * a;

      const d = this.spectrum[k] - this.prevSpectrum[k];
      if (d > 0) flux += d;
    }

    const avg = (from, to) => {
      let s = 0;
      for (let i = from; i < to; i++) s += this.spectrum[i];
      return s / (to - from);
    };

    this.bass = avg(0, 14);
    this.lowMid = avg(14, 36);
    this.mid = avg(36, 76);
    this.high = avg(76, BINS);
    this.level = (this.bass * 1.15 + this.lowMid + this.mid + this.high * 0.8) / 4;
    this.flux = this.flux + (flux / BINS * 6 - this.flux) * 0.35;

    this.#detectBeat();

    this.chromaAnalyser.getByteFrequencyData(this.chromaData);
    this.onsetAnalyser.getByteFrequencyData(this.onsetData);
    this.midAnalyser.getByteFrequencyData(this.midData);
    this.sideAnalyser.getByteFrequencyData(this.sideData);
    this.music.update(dt, this.chromaData, this.onsetData, this.midData, this.sideData);
  }

  #decayIdle(dt) {
    const k = Math.pow(0.2, dt);
    this.bass *= k; this.lowMid *= k; this.mid *= k; this.high *= k;
    this.level *= k; this.flux *= k; this.beat *= k;
    this.spectrum.fill(0);
  }

  #detectBeat() {
    const e = this.bass * this.bass;
    this.bassHistory[this.bassIndex] = e;
    this.bassIndex = (this.bassIndex + 1) % this.bassHistory.length;

    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < this.bassHistory.length; i++) {
      sum += this.bassHistory[i];
      sumSq += this.bassHistory[i] * this.bassHistory[i];
    }
    const n = this.bassHistory.length;
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const threshold = mean * (1.45 + Math.sqrt(variance) * 2.4);

    const now = performance.now() / 1000;
    if (e > threshold && e > 0.0035 && now - this.lastBeatAt > 0.19) {
      this.lastBeatAt = now;
      this.beatAge = 0;
      this.beat = Math.min(1.6, 0.55 + Math.sqrt(e) * 2.4);
    }
  }
}

/**
 * A slow four-chord nocturne: struck-string arpeggios over a breathing pad,
 * everything folded through a procedurally generated reverb tail.
 */
class AmbientPiece {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.bpm = 62;
    this.stepDur = 60 / this.bpm / 2; // eighth notes

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.72;
    this.dry.connect(this.out);

    this.wet = ctx.createGain();
    this.wet.gain.value = 0.85;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 3.6, 2.4);
    this.reverb.connect(this.wet);
    this.wet.connect(this.out);

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5200;
    this.tone.Q.value = 0.4;
    this.tone.connect(this.dry);
    this.tone.connect(this.reverb);

    this.#buildAir();

    // i - VI - III - VII in D minor, voiced open.
    this.chords = [
      { root: 38, notes: [50, 57, 65, 69, 72] },
      { root: 34, notes: [46, 53, 62, 65, 69] },
      { root: 41, notes: [53, 60, 65, 69, 72] },
      { root: 36, notes: [48, 55, 60, 64, 67] },
    ];
    this.pattern = [0, 2, 4, 3, 1, 3, 2, 4, 0, 3, 2, 1, 4, 2, 3, 1];
    this.step = 0;
  }

  #buildAir() {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 4);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      let b0 = 0;
      let b1 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99 * b0 + w * 0.05;
        b1 = 0.96 * b1 + w * 0.12;
        // Cross-fade the loop seam so the pad never ticks.
        const fade = Math.min(1, Math.min(i, len - i) / (ctx.sampleRate * 0.4));
        ch[i] = (b0 + b1) * fade;
      }
    }
    this.air = ctx.createBufferSource();
    this.air.buffer = buf;
    this.air.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    this.air.connect(bp).connect(g).connect(this.reverb);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 1200;
    lfo.connect(lfoGain).connect(bp.frequency);
    lfo.start();
    this.airLfo = lfo;
  }

  start() {
    const t = this.ctx.currentTime;
    this.air.start(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(0.85, t + 4);
    this.nextTime = t + 0.15;
    this.timer = setInterval(() => this.#schedule(), 25);
    this.#chord(0, t + 0.15);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.6);
    try { this.air.stop(t + 0.7); this.airLfo.stop(t + 0.7); } catch { /* noop */ }
    setTimeout(() => this.out.disconnect(), 1000);
  }

  #schedule() {
    while (this.nextTime < this.ctx.currentTime + 0.4) {
      this.#playStep(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step++;
    }
  }

  #playStep(step, time) {
    const barSteps = 8;
    const chordIndex = Math.floor(step / (barSteps * 2)) % this.chords.length;
    const chord = this.chords[chordIndex];

    if (step % (barSteps * 2) === 0) {
      this.#chord(chordIndex, time);
      this.#bass(chord.root, time);
    }

    const s = step % this.pattern.length;
    // Leave holes in the pattern so the phrase breathes.
    if (s === 5 || s === 11 || (step % 32) >= 28) return;

    const note = chord.notes[this.pattern[s]];
    const accent = s % 4 === 0 ? 1.0 : 0.62;
    const vel = (0.055 + Math.random() * 0.02) * accent;
    const octave = Math.random() < 0.16 ? 12 : 0;
    this.#pluck(note + octave, time + (Math.random() - 0.5) * 0.012, vel);
  }

  #pluck(midi, time, vel) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const dur = 2.6 + Math.random() * 1.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(vel, time + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    env.connect(this.tone);

    const partials = [
      [1.0, 1.0, 'triangle'],
      [2.0, 0.30, 'sine'],
      [3.01, 0.13, 'sine'],
      [4.03, 0.055, 'sine'],
      [6.05, 0.022, 'sine'],
    ];
    for (const [mult, gain, type] of partials) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      o.detune.value = (Math.random() - 0.5) * 7;
      const g = ctx.createGain();
      // Higher partials die first, like a real string.
      g.gain.setValueAtTime(gain, time);
      g.gain.exponentialRampToValueAtTime(gain * 0.02, time + dur * (0.9 / mult));
      o.connect(g).connect(env);
      o.start(time);
      o.stop(time + dur + 0.1);
    }
  }

  #bass(midi, time) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 12 - 69) / 12);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.16, time + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 5.5);
    o.connect(g).connect(this.dry);
    g.connect(this.reverb);
    o.start(time);
    o.stop(time + 5.6);
  }

  #chord(index, time) {
    const ctx = this.ctx;
    const chord = this.chords[index];
    const dur = this.stepDur * 16;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(420, time);
    filt.frequency.linearRampToValueAtTime(1500, time + dur * 0.45);
    filt.frequency.linearRampToValueAtTime(500, time + dur);
    filt.Q.value = 1.1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(0.030, time + dur * 0.35);
    env.gain.linearRampToValueAtTime(0.0001, time + dur * 1.05);
    filt.connect(env);
    env.connect(this.dry);
    env.connect(this.reverb);

    for (const midi of chord.notes.slice(0, 4)) {
      const f = 440 * Math.pow(2, (midi - 12 - 69) / 12);
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.5;
        o.connect(g).connect(filt);
        o.start(time);
        o.stop(time + dur * 1.1);
      }
    }
  }
}

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Soft pre-delay ramp avoids the metallic slap of a raw noise burst.
      const onset = Math.min(1, t * 40);
      ch[i] = (Math.random() * 2 - 1) * onset * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

export { BINS as SPECTRUM_BINS };
