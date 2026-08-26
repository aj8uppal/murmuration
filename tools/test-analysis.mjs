/**
 * Unit tests for src/analysis.js, driven by synthetic FFT frames with known
 * answers. No browser, no audio device, no flaky bridge - if the key detector
 * cannot tell C major from C minor here, it will not manage it on real music.
 *
 *   node tools/test-analysis.mjs
 */
import { MusicAnalysis } from '../src/analysis.js';

const SAMPLE_RATE = 44100;
const CHROMA_BINS = 4096;   // fftSize 8192
const ONSET_BINS = 512;     // fftSize 1024
const NYQUIST = SAMPLE_RATE / 2;

let failures = 0;
function check(name, pass, detail) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass) failures++;
}

/** Byte-magnitude spectrum containing the given pitches and their harmonics. */
function spectrumFor(freqs, { harmonics = 4, peak = 235 } = {}) {
  const bins = new Uint8Array(CHROMA_BINS);
  const perBin = NYQUIST / CHROMA_BINS;
  for (const f of freqs) {
    for (let h = 1; h <= harmonics; h++) {
      const centre = (f * h) / perBin;
      const amp = peak / h;
      // Spread over a couple of bins, as a real windowed FFT would.
      for (let d = -2; d <= 2; d++) {
        const i = Math.round(centre) + d;
        if (i < 1 || i >= CHROMA_BINS) continue;
        const v = amp * Math.exp(-(d * d) / 1.6);
        bins[i] = Math.min(255, bins[i] + v);
      }
    }
  }
  return bins;
}

const NOTE = (semitonesAboveC4) => 261.6256 * Math.pow(2, semitonesAboveC4 / 12);
const C_MAJOR = [NOTE(0), NOTE(4), NOTE(7), NOTE(12), NOTE(16)];
const C_MINOR = [NOTE(0), NOTE(3), NOTE(7), NOTE(12), NOTE(15)];
const A_MAJOR = [NOTE(9), NOTE(13), NOTE(16), NOTE(21)];

function run(spectrum, onsetFrames, seconds, dt = 1 / 60) {
  const m = new MusicAnalysis(SAMPLE_RATE);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    m.update(dt, spectrum, onsetFrames(i));
  }
  return m;
}

const silentOnsets = () => new Uint8Array(ONSET_BINS);

console.log('\nkey and mode');
{
  const maj = run(spectrumFor(C_MAJOR), silentOnsets, 20);
  check('C major triad reads major', maj.mode > 0.15, `mode=${maj.mode.toFixed(2)} key=${maj.keyName}`);
  check('C major triad names C', maj.keyName.startsWith('C '), maj.keyName);

  const min = run(spectrumFor(C_MINOR), silentOnsets, 20);
  check('C minor triad reads minor', min.mode < -0.15, `mode=${min.mode.toFixed(2)} key=${min.keyName}`);
  check('C minor triad names C', min.keyName.startsWith('C '), min.keyName);

  check('major and minor are separated',
    maj.mode - min.mode > 0.5, `gap=${(maj.mode - min.mode).toFixed(2)}`);

  const a = run(spectrumFor(A_MAJOR), silentOnsets, 20);
  check('A major triad names A', a.keyName.startsWith('A '), a.keyName);

  const quiet = run(new Uint8Array(CHROMA_BINS), silentOnsets, 10);
  check('silence does not assert a mode', Math.abs(quiet.mode) < 0.2, `mode=${quiet.mode.toFixed(2)}`);
}

console.log('\ntempo');
for (const bpm of [90, 120, 140]) {
  const period = 60 / bpm;
  const onsets = (i) => {
    const t = i / 60;
    const phase = (t % period) / period;
    // Sharp attack, quick decay - a percussive pulse.
    const env = Math.exp(-phase * 14);
    const b = new Uint8Array(ONSET_BINS);
    for (let k = 1; k < ONSET_BINS; k++) b[k] = Math.min(255, 200 * env * (1 - k / ONSET_BINS));
    return b;
  };
  const m = run(spectrumFor(C_MAJOR), onsets, 22);
  const err = Math.abs(m.tempo - bpm);
  check(`${bpm} BPM pulse detected`, err < bpm * 0.06,
    `got ${m.tempo.toFixed(1)} conf=${m.tempoConfidence.toFixed(2)}`);
}

console.log('\ndensity, lull and breath');
{
  const loudBand = () => {
    const b = new Uint8Array(ONSET_BINS);
    for (let k = 1; k < ONSET_BINS; k++) b[k] = 200;
    return b;
  };
  const quietBand = () => {
    const b = new Uint8Array(ONSET_BINS);
    // Only the bottom band, mimicking the rumble that persists in a quiet bar.
    for (let k = 1; k < 12; k++) b[k] = 130;
    return b;
  };

  const m = new MusicAnalysis(SAMPLE_RATE);
  const spec = spectrumFor(C_MINOR);
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 25; i++) m.update(dt, spec, loudBand());
  const loudDensity = m.density;
  const loudLull = m.lull;

  for (let i = 0; i < 60 * 25; i++) m.update(dt, spec, quietBand());
  const quietDensity = m.density;
  const quietLull = m.lull;
  const quietBreath = m.breath;

  check('full passage reads dense', loudDensity > 0.7, `density=${loudDensity.toFixed(2)}`);
  check('full passage has no lull', loudLull < 0.15, `lull=${loudLull.toFixed(2)}`);
  check('quiet passage loses density', quietDensity < 0.35, `density=${quietDensity.toFixed(2)}`);
  check('quiet passage raises the lull', quietLull > 0.5, `lull=${quietLull.toFixed(2)}`);
  check('breath is alive during the lull', quietBreath > 0.05, `breath=${quietBreath.toFixed(2)}`);

  // The lull must lift promptly when the music returns, or the visuals lag
  // behind the re-entry.
  for (let i = 0; i < 60 * 4; i++) m.update(dt, spec, loudBand());
  check('lull falls promptly on re-entry', m.lull < quietLull * 0.5,
    `${quietLull.toFixed(2)} -> ${m.lull.toFixed(2)} in 4s`);
}

console.log('\nonsets are transient, not a level');
{
  const spec = spectrumFor(C_MINOR);
  const dt = 1 / 60;

  // Held strings: loud, but nothing new is happening. This is the case that
  // was reading as glare - flux hovered above the adaptive mean and re-armed
  // `onset` every frame, so it behaved like a level rather than an event.
  {
    const m = new MusicAnalysis(SAMPLE_RATE);
    let sum = 0, n = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const b = new Uint8Array(ONSET_BINS);
      for (let k = 1; k < ONSET_BINS; k++) {
        b[k] = Math.min(255, 175 + Math.sin(i * 0.07 + k) * 4);   // bow noise only
      }
      m.update(dt, spec, b);
      if (i > 60 * 5) { sum += m.onset; n++; }
    }
    check('held notes do not pin onset high', sum / n < 0.08, `meanOnset=${(sum / n).toFixed(3)}`);
  }

  // Discrete notes at a plausible rate must still articulate, and must fall
  // back to near nothing between them.
  {
    const m = new MusicAnalysis(SAMPLE_RATE);
    let sum = 0, n = 0, peak = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const phase = (i % 40) / 40;              // 1.5 notes per second
      const env = Math.exp(-phase * 12);
      const b = new Uint8Array(ONSET_BINS);
      for (let k = 1; k < ONSET_BINS; k++) b[k] = Math.min(255, 210 * env);
      m.update(dt, spec, b);
      if (i > 60 * 5) { sum += m.onset; n++; peak = Math.max(peak, m.onset); }
    }
    const mean = sum / n;
    check('discrete notes still articulate', peak > 0.25, `peak=${peak.toFixed(2)}`);
    check('and fall away between notes', mean / Math.max(peak, 1e-6) < 0.30,
      `duty=${(mean / Math.max(peak, 1e-6)).toFixed(2)} mean=${mean.toFixed(3)}`);
  }
}

console.log('\ninstrument entry');
{
  const m = new MusicAnalysis(SAMPLE_RATE);
  const spec = spectrumFor(C_MAJOR);
  const dt = 1 / 60;
  const lowOnly = new Uint8Array(ONSET_BINS);
  for (let k = 1; k < 10; k++) lowOnly[k] = 120;

  for (let i = 0; i < 60 * 20; i++) m.update(dt, spec, lowOnly);
  const before = m.entry;

  // A voice arrives in a band that had been empty.
  const withMid = new Uint8Array(lowOnly);
  for (let k = 40; k < 120; k++) withMid[k] = 190;
  let fired = 0;
  for (let i = 0; i < 60 * 3; i++) { m.update(dt, spec, withMid); if (m.entry > 0.1) fired++; }

  check('quiet stretch fires no entry', before < 0.05, `entry=${before.toFixed(2)}`);
  check('a new band fires an entry', fired > 0, `frames above threshold=${fired}, band=${m.entryName}`);
}

const STEREO_BINS = 1024;   // fftSize 2048

/** mid/side byte spectra for content placed centre or wide in the vocal band. */
function stereoPair({ centreLevel = 0, wideLevel = 0 }) {
  const mid = new Uint8Array(STEREO_BINS);
  const side = new Uint8Array(STEREO_BINS);
  const perBin = NYQUIST / STEREO_BINS;
  for (let i = 1; i < STEREO_BINS; i++) {
    const f = i * perBin;
    if (f < 260 || f > 3400) continue;
    // Centred content shows in mid only; wide content shows in both.
    mid[i] = Math.min(255, centreLevel + wideLevel);
    side[i] = Math.min(255, wideLevel);
  }
  return [mid, side];
}

console.log('\nvoice, from centre against sides');
{
  const spec = spectrumFor(C_MINOR);
  const onsets = () => { const b = new Uint8Array(ONSET_BINS); for (let k=1;k<ONSET_BINS;k++) b[k]=150; return b; };
  const dt = 1 / 60;

  const drive = (pair, seconds, m = new MusicAnalysis(SAMPLE_RATE)) => {
    for (let i = 0; i < 60 * seconds; i++) m.update(dt, spec, onsets(), pair[0], pair[1]);
    return m;
  };

  // A wide arrangement, then a centred vocal arriving over it.
  const m = new MusicAnalysis(SAMPLE_RATE);
  drive(stereoPair({ wideLevel: 150 }), 18, m);
  const instrumentalOnly = m.voice;
  drive(stereoPair({ wideLevel: 150, centreLevel: 80 }), 10, m);
  const withVocal = m.voice;

  check('wide arrangement alone reads no voice', instrumentalOnly < 0.25,
    `voice=${instrumentalOnly.toFixed(2)}`);
  check('a centred vocal over it registers', withVocal > 0.55, `voice=${withVocal.toFixed(2)}`);
  check('the two are clearly separated', withVocal - instrumentalOnly > 0.4,
    `gap=${(withVocal - instrumentalOnly).toFixed(2)}`);

  // Mono: side is identically zero, so everything looks centred. The detector
  // must report that it cannot tell, rather than claiming constant vocal.
  const monoMid = new Uint8Array(STEREO_BINS).fill(160);
  const monoSide = new Uint8Array(STEREO_BINS);
  const mono = drive([monoMid, monoSide], 20);
  check('mono source reports no confidence', mono.voiceConfidence < 0.2,
    `confidence=${mono.voiceConfidence.toFixed(2)}`);
  check('mono source does not claim a voice', mono.voice < 0.2, `voice=${mono.voice.toFixed(2)}`);
}

console.log('\nstruck against held');
{
  const spec = spectrumFor(C_MAJOR);
  const dt = 1 / 60;

  const struck = new MusicAnalysis(SAMPLE_RATE);
  for (let i = 0; i < 60 * 20; i++) {
    const env = Math.exp(-((i % 30) / 30) * 11);
    const b = new Uint8Array(ONSET_BINS);
    for (let k = 1; k < ONSET_BINS; k++) b[k] = Math.min(255, 215 * env);
    struck.update(dt, spec, b);
  }

  const held = new MusicAnalysis(SAMPLE_RATE);
  for (let i = 0; i < 60 * 20; i++) {
    const b = new Uint8Array(ONSET_BINS);
    for (let k = 1; k < ONSET_BINS; k++) b[k] = 175;
    held.update(dt, spec, b);
  }

  check('struck playing reads percussive', struck.percussiveness > held.percussiveness + 0.15,
    `struck=${struck.percussiveness.toFixed(2)} held=${held.percussiveness.toFixed(2)}`);
  check('held playing reads sustained', held.percussiveness < 0.25,
    `percussiveness=${held.percussiveness.toFixed(2)}`);
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
