/**
 * Musical analysis.
 *
 * The spectrum alone tells you how loud things are. This works out what the
 * music is actually doing: how fast it is going, whether it is in a major or
 * minor key, when a new instrument arrives, and when it stops to breathe.
 *
 * Everything here runs on FFT frames, so it works for any track, not just the
 * bundled one. Three analysers feed it because the jobs want different windows:
 * key needs fine frequency resolution, onsets need fine time resolution.
 */

// Krumhansl-Kessler key profiles: how strongly each scale degree belongs to a
// major or a minor key. Correlating a chroma vector against all 12 rotations of
// both gives you key and mode together.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Chroma is taken from this range only. Below it the FFT bins are wider than a
// semitone and the pitch classes smear together; above it there is little but
// harmonics and air.
const CHROMA_LO_HZ = 196;
const CHROMA_HI_HZ = 2100;

const FLUX_HZ = 60;              // fixed-rate onset envelope, independent of rAF
const FLUX_LEN = 512;            // ~8.5s of history, enough for autocorrelation
const MIN_LAG = 20;              // 180 BPM
const MAX_LAG = 75;              // 48 BPM

// Where a lead vocal lives. Below this a bass guitar is also centred; above it
// there is mostly air and cymbals, which are usually wide.
const VOICE_LO_HZ = 260;
const VOICE_HI_HZ = 3400;
// How much side energy to subtract before calling what is left centred.
const VOICE_SIDE_REJECT = 2.0;
// Must match the analyser settings the bytes came from.
const ANALYSER_MIN_DB = -95;
const ANALYSER_MAX_DB = -12;

const BAND_EDGES_HZ = [0, 120, 320, 800, 2000, 5000, 22050];
const BAND_NAMES = ['sub', 'bass', 'low-mid', 'mid', 'presence', 'air'];

// How much each band says about whether the music is FULL rather than merely
// present. Measured on the bundled track: the sub band sits near 0.5 even in a
// near-silent bar, so weighting it equally makes silence look loud. The upper
// middle is what actually separates a held piano note from a full arrangement.
const FULLNESS_WEIGHTS = [0.25, 0.6, 1.0, 1.3, 1.2, 0.8];

export class MusicAnalysis {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;

    this.chroma = new Float32Array(12);
    this.chromaSlow = new Float32Array(12);
    this.key = -1;
    this.keyName = '';
    this.mode = 0;               // -1 fully minor .. +1 fully major
    this.modeConfidence = 0;

    this.tempo = 0;              // BPM, 0 until confident
    this.tempoConfidence = 0;
    this.beatPhase = 0;          // 0..1 through the current beat
    this.tempoDrift = 0;         // signed, recent change in BPM

    this.onset = 0;              // broadband transient impulse, decays
    this.onsetRate = 0;          // onsets per second
    this.density = 0;            // how busy the music is, 0..1
    this.lull = 0;               // slow inverse of density - drives the breath
    this.breath = 0;             // 0..1 oscillation, only alive during a lull

    this.voice = 0;              // centre-dominant energy in the vocal band
    this.voiceConfidence = 0;    // zero for mono sources, where the test is meaningless
    this.attack = 0;             // instantaneous transient energy
    this.percussiveness = 0;     // struck vs bowed/held, 0..1
    this.bandAttack = new Float32Array(BAND_NAMES.length);
    this.bandSustain = new Float32Array(BAND_NAMES.length);

    this.bands = new Float32Array(BAND_NAMES.length);
    this.entry = 0;              // impulse when an instrument arrives
    this.entryBand = -1;
    this.entryName = '';

    this.#reset();
  }

  #reset() {
    this.flux = new Float32Array(FLUX_LEN);
    this.fluxHead = 0;
    this.fluxAcc = 0;
    this.fluxClock = 0;
    this.prevChromaMag = null;
    this.prevOnsetMag = null;
    this.tempoClock = 0;
    this.shortEnergy = 0;
    this.longEnergy = 0;
    this.onsetClock = 0;
    this.onsetCount = 0;
    this.peakEnergy = 0.30;
    this.bandFast = new Float32Array(BAND_NAMES.length);
    this.bandSlow = new Float32Array(BAND_NAMES.length);
    this.bandCooldown = new Float32Array(BAND_NAMES.length);
    this.binMapsBuilt = false;
  }

  #buildBinMaps(chromaBins, onsetBins) {
    const nyquist = this.sampleRate / 2;

    // Chroma: each bin -> pitch class, ignoring anything outside the useful range.
    this.chromaBin = new Int8Array(chromaBins).fill(-1);
    this.chromaWeight = new Float32Array(chromaBins);
    for (let i = 1; i < chromaBins; i++) {
      const f = (i / chromaBins) * nyquist;
      if (f < CHROMA_LO_HZ || f > CHROMA_HI_HZ) continue;
      const midi = 12 * Math.log2(f / 440) + 69;
      const nearest = Math.round(midi);
      // Weight by closeness to the semitone centre so bins between two notes
      // do not vote at full strength for either.
      const cents = Math.abs(midi - nearest);
      if (cents > 0.5) continue;
      this.chromaBin[i] = ((nearest % 12) + 12) % 12;
      this.chromaWeight[i] = Math.cos(cents * Math.PI);
    }

    this.bandOf = new Int8Array(onsetBins);
    for (let i = 0; i < onsetBins; i++) {
      const f = (i / onsetBins) * nyquist;
      let b = BAND_EDGES_HZ.length - 2;
      for (let k = 0; k < BAND_EDGES_HZ.length - 1; k++) {
        if (f >= BAND_EDGES_HZ[k] && f < BAND_EDGES_HZ[k + 1]) { b = k; break; }
      }
      this.bandOf[i] = b;
    }

    this.prevChromaMag = new Float32Array(chromaBins);
    this.prevOnsetMag = new Float32Array(onsetBins);
    this.binMapsBuilt = true;
  }

  #buildVoiceRange(bins) {
    const nyquist = this.sampleRate / 2;
    this.voiceLo = Math.max(1, Math.floor((VOICE_LO_HZ / nyquist) * bins));
    this.voiceHi = Math.min(bins - 1, Math.ceil((VOICE_HI_HZ / nyquist) * bins));

    // The bytes are a dB scale. Comparing centre against sides has to happen in
    // energy, not in dB: a dB gap says how much louder the centre is, which is
    // the same number whether the passage is a whisper or a wall of strings.
    // Summed energy says how much centred material there actually is.
    this.byteToLin = new Float32Array(256);
    for (let b = 0; b < 256; b++) {
      const db = ANALYSER_MIN_DB + (b / 255) * (ANALYSER_MAX_DB - ANALYSER_MIN_DB);
      this.byteToLin[b] = b < 8 ? 0 : Math.pow(10, db / 20);
    }
    this.voiceRangeBuilt = true;
  }

  /**
   * Centre-dominant energy in the vocal band.
   *
   * These are dB-mapped bytes, so mid minus side is a level ratio rather than
   * an amplitude difference - which is what we want: it asks how many dB the
   * centre beats the sides by, independent of how loud the passage is.
   *
   * A mono source has no side channel at all, which would make everything look
   * perfectly centred. Confidence tracks how much side energy the track carries
   * overall, so mono files and microphone input report the truth instead.
   */
  #updateVoice(midBytes, sideBytes, dt) {
    if (!this.voiceRangeBuilt) this.#buildVoiceRange(midBytes.length);

    const lut = this.byteToLin;
    let centreEnergy = 0;
    let totalEnergy = 0;
    let sideEnergy = 0;
    for (let i = this.voiceLo; i <= this.voiceHi; i++) {
      const mL = lut[midBytes[i]];
      const sL = lut[sideBytes[i]];
      centreEnergy += Math.max(0, mL - VOICE_SIDE_REJECT * sL);
      totalEnergy += mL;
      sideEnergy += sL;
    }
    // With almost nothing playing, a handful of bins scraping over the floor
    // would otherwise read as a confident vocal through the fade.
    const raw = totalEnergy > 1e-4 ? centreEnergy : 0;

    this.stereoWidth = (this.stereoWidth ?? 0)
      + ((totalEnergy > 1e-6 ? sideEnergy / totalEnergy : 0) - (this.stereoWidth ?? 0))
        * (1 - Math.pow(0.5, dt / 4));
    const confTarget = Math.min(1, this.stereoWidth / 0.12);
    this.voiceConfidence += (confTarget - this.voiceConfidence) * (1 - Math.pow(0.5, dt / 2));

    // A ceiling alone is not enough. On this track the piano is centre-panned
    // as well as the voice, so there is a large constant floor of centred
    // energy and the vocal is the excursion above it - measuring against the
    // peak only gave 1.4x separation. Tracking the floor as well, and reading
    // the gap between them, is what makes the voice legible.
    if (this.voiceFloor === undefined) this.voiceFloor = raw;
    this.voiceFloor = raw < this.voiceFloor
      ? raw                                                          // settle at once
      : this.voiceFloor + (raw - this.voiceFloor) * (1 - Math.pow(0.5, dt / 75));
    this.voicePeak = Math.max(raw, (this.voicePeak ?? 0) * Math.pow(0.5, dt / 45));

    const span = this.voicePeak - this.voiceFloor;
    const rel = span > 1e-6 ? (raw - this.voiceFloor) / span : 0;
    const target = smoothstep(0.25, 0.68, rel) * this.voiceConfidence;
    const tau = target > this.voice ? 0.20 : 1.1;   // arrives quickly, holds across a phrase
    this.voice += (target - this.voice) * (1 - Math.pow(0.5, dt / tau));
  }

  /**
   * @param {number} dt seconds since the last call
   * @param {Uint8Array} chromaBytes long-window FFT, for key and mode
   * @param {Uint8Array} onsetBytes  short-window FFT, for transients and tempo
   */
  update(dt, chromaBytes, onsetBytes, midBytes, sideBytes) {
    if (!this.binMapsBuilt) this.#buildBinMaps(chromaBytes.length, onsetBytes.length);
    const step = Math.min(dt, 0.1);

    if (midBytes && sideBytes) this.#updateVoice(midBytes, sideBytes, step);
    this.#updateChroma(chromaBytes, step);
    this.#updateFlux(onsetBytes, step);
    this.#updateBands(onsetBytes, step);
    this.#updateArticulation(step);
    this.#updateTempo(step);
    this.#updateDensity(step);
    this.onset *= Math.pow(0.004, step);
    this.entry *= Math.pow(0.05, step);
  }

  #updateChroma(bytes, dt) {
    const c = this.chroma;
    c.fill(0);
    let total = 0;
    for (let i = 1; i < bytes.length; i++) {
      const pc = this.chromaBin[i];
      if (pc < 0) continue;
      // Square the byte magnitude so loud partials dominate the vote.
      const m = (bytes[i] / 255) ** 2 * this.chromaWeight[i];
      c[pc] += m;
      total += m;
    }
    if (total > 1e-6) for (let k = 0; k < 12; k++) c[k] /= total;

    // Key changes slowly; average over seconds so a passing note cannot flip it.
    const a = 1 - Math.pow(0.5, dt / 2.5);
    for (let k = 0; k < 12; k++) this.chromaSlow[k] += (c[k] - this.chromaSlow[k]) * a;

    this.#updateKey(dt);
  }

  #updateKey(dt) {
    const c = this.chromaSlow;
    let sum = 0;
    for (let k = 0; k < 12; k++) sum += c[k];
    if (sum < 1e-6) return;

    let bestMajor = -2;
    let bestMinor = -2;
    let bestMajorKey = 0;
    let bestMinorKey = 0;
    for (let r = 0; r < 12; r++) {
      const maj = correlate(c, MAJOR_PROFILE, r);
      const min = correlate(c, MINOR_PROFILE, r);
      if (maj > bestMajor) { bestMajor = maj; bestMajorKey = r; }
      if (min > bestMinor) { bestMinor = min; bestMinorKey = r; }
    }

    const major = bestMajor >= bestMinor;
    const key = major ? bestMajorKey : bestMinorKey;
    // How clearly one mode beats the other, not how well either fits.
    const separation = Math.abs(bestMajor - bestMinor);
    const target = Math.max(-1, Math.min(1, (bestMajor - bestMinor) * 6));

    const a = 1 - Math.pow(0.5, dt / 3.0);
    this.mode += (target - this.mode) * a;
    this.modeConfidence += (Math.min(1, separation * 8) - this.modeConfidence) * a;
    if (Math.max(bestMajor, bestMinor) > 0.2) {
      this.key = key;
      this.keyName = NOTE_NAMES[key] + (major ? ' major' : ' minor');
    }
  }

  #updateFlux(bytes, dt) {
    const prev = this.prevOnsetMag;
    let flux = 0;
    for (let i = 1; i < bytes.length; i++) {
      const m = bytes[i] / 255;
      const d = m - prev[i];
      if (d > 0) flux += d;
      prev[i] = m;
    }
    flux /= bytes.length;

    // Resample the envelope onto a fixed grid so autocorrelation lags map to a
    // constant time base regardless of how the frame rate wanders.
    this.fluxAcc += flux;
    this.fluxClock += dt;
    const stepDur = 1 / FLUX_HZ;
    while (this.fluxClock >= stepDur) {
      this.fluxClock -= stepDur;
      this.flux[this.fluxHead] = this.fluxAcc;
      this.fluxHead = (this.fluxHead + 1) % FLUX_LEN;
      this.fluxAcc = 0;
    }

    // Adaptive onset threshold over the last ~1s of the envelope.
    let mean = 0;
    for (let i = 0; i < 64; i++) mean += this.flux[(this.fluxHead - 1 - i + FLUX_LEN * 2) % FLUX_LEN];
    mean /= 64;

    // Hysteresis and a refractory window, so this reports transients rather
    // than a level. Without them, sustained playing keeps flux above the
    // adaptive mean and re-triggers every frame, leaving `onset` pinned high -
    // which reads on screen as a constant glare instead of articulation.
    this.onsetClockAbs = (this.onsetClockAbs ?? 0) + dt;
    if (flux < mean * 1.5) this.onsetArmed = true;
    const clear = flux > mean * 2.9 && flux > 0.006;
    if (clear && this.onsetArmed !== false && this.onsetClockAbs - (this.lastOnsetAt ?? -10) > 0.11) {
      this.onsetArmed = false;
      this.lastOnsetAt = this.onsetClockAbs;
      this.onset = Math.min(1, flux * 44);
      this.onsetCount++;
    }
  }

  #updateBands(bytes, dt) {
    const acc = new Float32Array(BAND_NAMES.length);
    const counts = new Int32Array(BAND_NAMES.length);
    for (let i = 1; i < bytes.length; i++) {
      const b = this.bandOf[i];
      acc[b] += bytes[i] / 255;
      counts[b]++;
    }
    const aFast = 1 - Math.pow(0.5, dt / 0.12);
    const aSlow = 1 - Math.pow(0.5, dt / 4.0);
    for (let b = 0; b < BAND_NAMES.length; b++) {
      const v = counts[b] ? acc[b] / counts[b] : 0;
      this.bands[b] = v;
      this.bandFast[b] += (v - this.bandFast[b]) * aFast;
      this.bandSlow[b] += (v - this.bandSlow[b]) * aSlow;
      this.bandCooldown[b] = Math.max(0, this.bandCooldown[b] - dt);

      // Struck versus held, per band. A piano and a string section can occupy
      // the same octaves and still look nothing alike: the piano surges above
      // its own running level on every strike and decays away, the strings sit
      // on theirs. Relative to the band's own level, so a quiet band is not
      // permanently judged sustained just for being quiet.
      const surge = Math.max(0, this.bandFast[b] - this.bandSlow[b])
                  / Math.max(this.bandSlow[b], 0.06);
      this.bandAttack[b] = Math.min(1, surge * 1.4);
      this.bandSustain[b] = Math.min(1, this.bandSlow[b] * 2.2);

      // An entry is a band that was quiet for a while and is suddenly not.
      // An arrival should be rare and mean something - it carries the largest
      // brightness weight of any event, so a loose bar here reads as flicker.
      const arrived = this.bandFast[b] > this.bandSlow[b] * 2.6 + 0.05
                   && this.bandSlow[b] < 0.15
                   && this.bandFast[b] > 0.12;
      if (arrived && this.bandCooldown[b] === 0) {
        this.bandCooldown[b] = 5.0;
        this.entry = Math.min(1, (this.bandFast[b] - this.bandSlow[b]) * 3);
        this.entryBand = b;
        this.entryName = BAND_NAMES[b];
      }
    }
  }

  #updateArticulation(dt) {
    let att = 0;
    let sus = 0;
    let wsum = 0;
    for (let b = 0; b < BAND_NAMES.length; b++) {
      const w = FULLNESS_WEIGHTS[b];
      att += this.bandAttack[b] * w;
      sus += this.bandSustain[b] * w;
      wsum += w;
    }
    att /= wsum;
    sus /= wsum;

    this.attack += (att - this.attack) * (1 - Math.pow(0.5, dt / 0.10));
    const balance = att / (att + sus + 1e-4);
    this.percussiveness += (balance - this.percussiveness) * (1 - Math.pow(0.5, dt / 1.2));
  }

  #updateTempo(dt) {
    this.tempoClock += dt;

    if (this.tempo > 0) {
      this.beatPhase += dt * (this.tempo / 60);
      if (this.beatPhase >= 1) this.beatPhase -= Math.floor(this.beatPhase);
      // Phase-lock: pull the grid toward strong onsets rather than resetting.
      if (this.onset > 0.35) {
        const err = this.beatPhase < 0.5 ? -this.beatPhase : 1 - this.beatPhase;
        this.beatPhase += err * 0.10;
        if (this.beatPhase < 0) this.beatPhase += 1;
      }
    }

    if (this.tempoClock < 0.5) return;
    this.tempoClock = 0;

    // Unwrap the ring into chronological order and remove the mean.
    const x = new Float32Array(FLUX_LEN);
    let mean = 0;
    for (let i = 0; i < FLUX_LEN; i++) {
      x[i] = this.flux[(this.fluxHead + i) % FLUX_LEN];
      mean += x[i];
    }
    mean /= FLUX_LEN;
    let energy = 0;
    for (let i = 0; i < FLUX_LEN; i++) { x[i] -= mean; energy += x[i] * x[i]; }
    if (energy < 1e-9) return;

    let best = 0;
    let bestLag = 0;
    const ac = new Float32Array(MAX_LAG + 1);
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let s = 0;
      for (let i = 0; i < FLUX_LEN - lag; i++) s += x[i] * x[i + lag];
      s /= (FLUX_LEN - lag);
      ac[lag] = s;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag === 0 || best <= 0) return;

    // Octave disambiguation: autocorrelation is just as happy at half or double
    // the true tempo, so prefer whichever candidate lands in a musical range.
    let lag = bestLag;
    for (const cand of [bestLag * 2, Math.round(bestLag / 2)]) {
      if (cand < MIN_LAG || cand > MAX_LAG) continue;
      const bpmCand = 60 * FLUX_HZ / cand;
      const bpmCur = 60 * FLUX_HZ / lag;
      const better = inMusicalRange(bpmCand) && !inMusicalRange(bpmCur);
      if (better && ac[cand] > best * 0.6) lag = cand;
    }

    const bpm = 60 * FLUX_HZ / lag;
    const norm = energy / FLUX_LEN;
    const confidence = Math.max(0, Math.min(1, best / (norm + 1e-9)));

    if (confidence > 0.12) {
      const prev = this.tempo;
      this.tempo = prev === 0 ? bpm : prev + (bpm - prev) * 0.28;
      if (prev > 0) this.tempoDrift = this.tempo - prev;
    }
    this.tempoConfidence += (confidence - this.tempoConfidence) * 0.4;
  }

  #updateDensity(dt) {
    let fullness = 0;
    let wsum = 0;
    for (let b = 0; b < this.bands.length; b++) {
      fullness += this.bands[b] * FULLNESS_WEIGHTS[b];
      wsum += FULLNESS_WEIGHTS[b];
    }
    fullness /= wsum;

    this.shortEnergy += (fullness - this.shortEnergy) * (1 - Math.pow(0.5, dt / 0.35));
    this.longEnergy += (fullness - this.longEnergy) * (1 - Math.pow(0.5, dt / 12));

    // Judged against this track's own ceiling, not an absolute one, so a quiet
    // recording is not one long lull and a loud one still gets to rest. Starts
    // at a plausible prior rather than zero, or the opening bar of any track
    // reads as its loudest moment. Rises immediately, decays over a minute.
    this.peakEnergy = Math.max(this.shortEnergy, this.peakEnergy * Math.pow(0.5, dt / 60));

    this.onsetClock += dt;
    if (this.onsetClock >= 1) {
      this.onsetRate += (this.onsetCount - this.onsetRate) * 0.5;
      this.onsetCount = 0;
      this.onsetClock = 0;
    }

    // Busy is mostly about fullness. Onset rate is deliberately a minor term:
    // a sparse piano has MORE attacks per second than a sustained string swell,
    // so leaning on it would call the quietest passage the busiest one.
    const rel = this.peakEnergy > 0.02 ? this.shortEnergy / this.peakEnergy : 0;
    const full = smoothstep(0.45, 0.95, rel);
    const eventful = Math.min(1, this.onsetRate / 7);
    const target = Math.max(0, Math.min(1, full * 0.82 + eventful * 0.18));
    this.density += (target - this.density) * (1 - Math.pow(0.5, dt / 0.8));

    // The lull leads the visuals, so it settles slower than it lifts: the field
    // should sink into a quiet passage gently and wake from it promptly.
    const lullTarget = Math.max(0, 1 - this.density * 1.25);
    const tau = lullTarget > this.lull ? 2.2 : 0.7;
    this.lull += (lullTarget - this.lull) * (1 - Math.pow(0.5, dt / tau));

    // A slow swell that only exists while the music is resting.
    this.breathClock = (this.breathClock ?? 0) + dt * (0.16 + this.lull * 0.10);
    this.breath = (Math.sin(this.breathClock * Math.PI * 2) * 0.5 + 0.5) * this.lull;
  }

  /** Snapshot for the renderer. */
  report() {
    return {
      tempo: this.tempo,
      tempoConfidence: this.tempoConfidence,
      beatPhase: this.beatPhase,
      mode: this.mode,
      modeConfidence: this.modeConfidence,
      key: this.key,
      keyName: this.keyName,
      onset: this.onset,
      density: this.density,
      lull: this.lull,
      breath: this.breath,
      entry: this.entry,
      entryName: this.entryName,
      voice: this.voice,
      voiceConfidence: this.voiceConfidence,
      attack: this.attack,
      percussiveness: this.percussiveness,
      bandAttack: this.bandAttack,
      bandSustain: this.bandSustain,
    };
  }
}

function correlate(chroma, profile, rotation) {
  let mc = 0;
  let mp = 0;
  for (let k = 0; k < 12; k++) { mc += chroma[k]; mp += profile[k]; }
  mc /= 12; mp /= 12;
  let num = 0;
  let dc = 0;
  let dp = 0;
  for (let k = 0; k < 12; k++) {
    const a = chroma[(k + rotation) % 12] - mc;
    const b = profile[k] - mp;
    num += a * b;
    dc += a * a;
    dp += b * b;
  }
  const den = Math.sqrt(dc * dp);
  return den > 1e-9 ? num / den : 0;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function inMusicalRange(bpm) { return bpm >= 70 && bpm <= 165; }

export { BAND_NAMES };
