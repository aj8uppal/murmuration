import { Renderer, SPECTRUM_BINS } from './renderer.js';
import { AudioEngine } from './audio.js';
import { SONG } from './song.js';
import { MusicAnalysis } from './analysis.js';

// `lights` and `sky` are the voyage populations; sparse is the point there,
// so lavish buys detail in the distance rather than a denser field.
const QUALITY = [
  { name: 'calm',    particles: 260000, scale: 0.85, lights: 6144, sky: 384 },
  { name: 'full',    particles: 620000, scale: 1.00, lights: 12288, sky: 768 },
  { name: 'lavish',  particles: 1200000, scale: 1.00, lights: 18432, sky: 1152 },
];

// A phone GPU will not carry the desktop particle counts, but it must still
// render at native resolution: trimming pixels means upscaling a small buffer
// onto a 3x screen, and the grains go soft. Pixels buy crispness, particles
// buy density - so on a handheld, spend on pixels and cut the particles.
const TOUCH = matchMedia('(pointer: coarse)').matches;
const SMALL = Math.min(window.innerWidth, window.innerHeight) < 700;
const HANDHELD = TOUCH && SMALL;

const HANDHELD_QUALITY = [
  { name: 'calm',   particles: 110000, scale: 1, lights: 3072, sky: 256 },
  { name: 'full',   particles: 240000, scale: 1, lights: 6144, sky: 384 },
  { name: 'lavish', particles: 460000, scale: 1, lights: 9216, sky: 576 },
];
const PRESETS = HANDHELD ? HANDHELD_QUALITY : QUALITY;

// Treatment, not signal: a style changes how a grain is drawn, while mood
// still chooses the palette and flowMode still chooses the motion.
const STYLES = ['nebula', 'ink', 'constellation', 'ribbon', 'etching'];
// Modes are whole rendering approaches, not treatments. Particle is the
// simulation; voyage is a raymarch you fly through.
const MODES = ['particle', 'voyage'];

const $ = (sel) => document.querySelector(sel);

class App {
  constructor() {
    this.canvas = $('#stage');
    this.renderer = new Renderer(this.canvas);
    this.audio = new AudioEngine();

    this.time = 0;
    this.lastFrame = performance.now();
    this.seedTime = Math.random() * 1000;
    this.quality = readStored('murmuration.quality', 1);

    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.cam = { zoom: 1, angle: 0, x: 0, y: 0, punch: 0 };
    this.userZoom = 1;
    this.userZoomTarget = 1;

    this.warmth = 0;
    this.mood = 0;        // palette bank position, 0..4
    this.flowMode = 0;    // flow behaviour position, 0..3
    this.breathScale = 1; // slow expansion during a lull
    this.compose = { x: 0, y: 0, stretch: 0, angle: 0, split: 0 };
    this.sensitivity = readStored('murmuration.sensitivity', 1);
    this.styleIndex = clamp(Math.round(readStored('murmuration.style', 0)), 0, STYLES.length - 1);
    this.modeIndex = clamp(Math.round(readStored('murmuration.mode', 0)), 0, MODES.length - 1);
    this.voyage = {
      z: 0, speed: 0, yaw: 0, pitch: 0, roll: 0, focus: 30, aperture: 1,
      pitchShort: 0, pitchLong: 0, steer: 0,
    };
    this.voyageSpectrum = new Float32Array(SPECTRUM_BINS);
    this.style = this.styleIndex;   // eased toward styleIndex, so switches glide
    this.scaledSpectrum = new Float32Array(SPECTRUM_BINS);
    this.mood = 0;        // palette bank position, 0..4
    this.flowMode = 0;    // flow behaviour position, 0..3

    this.fps = 60;
    this.slowFrames = 0;
    this.autoScaled = false;
  }

  async start() {
    try {
      await this.renderer.init();
    } catch (err) {
      this.#showUnsupported(err.message);
      return;
    }

    this.#wireUI();
    this.#wireInput();

    $('#boot').classList.add('gone');
    $('#intro').classList.add('ready');

    requestAnimationFrame(this.#loop);
  }

  #showUnsupported(message) {
    $('#boot').classList.add('gone');
    const panel = $('#unsupported');
    panel.classList.add('show');
    $('#unsupported-detail').textContent = message;
  }

  // ---------------------------------------------------------------- ui ----

  #wireUI() {
    $('#btn-song').addEventListener('click', () => this.#playSong());
    $('#btn-ambient').addEventListener('click', () => this.#begin(() => this.audio.startAmbient()));
    $('#btn-file').addEventListener('click', () => $('#file-input').click());
    $('#btn-mic').addEventListener('click', () => this.#useMic());
    $('#input-device').addEventListener('change', (e) => this.#useMic(e.target.value));

    $('#file-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this.#begin(() => this.audio.playFile(file));
    });

    $('#transport').addEventListener('click', () => {
      this.audio.togglePlay();
      this.#syncTransport();
    });

    const bar = $('#progress');
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      this.audio.seek((e.clientX - r.left) / r.width);
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dropping');
    });
    window.addEventListener('dragleave', () => document.body.classList.remove('dropping'));
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('audio')) this.#begin(() => this.audio.playFile(file));
    });

    this.spectrumCanvas = $('#ribbon');
    this.ribbonCtx = this.spectrumCanvas.getContext('2d');

    this.#setQuality(this.quality, { silent: true, persist: false });
    $('#sensitivity').textContent = `sens ${this.sensitivity.toFixed(1)}x`;
    $('#style').textContent = STYLES[this.styleIndex];
    $('#mode').textContent = MODES[this.modeIndex];
  }

  /**
   * Device labels are only readable after permission has been granted, so the
   * picker is populated once the stream is live rather than up front. This is
   * also how you point the piece at a loopback device to read another app's
   * output.
   */
  async #useMic(deviceId) {
    await this.#begin(() => this.audio.startMic(deviceId));
    const inputs = await this.audio.listInputs();
    if (inputs.length < 2) return;
    const sel = $('#input-device');
    sel.innerHTML = '';
    for (const d of inputs) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      o.selected = d.id === this.audio.micDeviceId;
      sel.append(o);
    }
    $('#input-picker').hidden = false;
  }

  async #playSong() {
    const btn = $('#btn-song');
    btn.classList.add('loading');
    btn.disabled = true;
    await this.#begin(() => this.audio.playUrl(SONG.src, `${SONG.title} · ${SONG.artist}`));
    btn.classList.remove('loading');
    btn.disabled = false;
  }

  async #begin(action) {
    try {
      await action();
    } catch (err) {
      this.#toast(err.message || String(err));
      return;
    }
    this.started = true;
    $('#intro').classList.add('gone');
    $('#hud').classList.add('show');
    $('#track-name').textContent = this.audio.trackName;
    $('#progress').classList.toggle('hidden', this.audio.mode !== 'file');
    this.#syncTransport();
    this.#armIdleTimer();
  }

  #syncTransport() {
    $('#transport').classList.toggle('paused', !this.audio.playing);
  }

  #toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  #armIdleTimer() {
    clearTimeout(this.idleTimer);
    document.body.classList.remove('idle');
    this.idleTimer = setTimeout(() => {
      if (this.started) document.body.classList.add('idle');
    }, 3200);
  }

  /**
   * `persist` is deliberately separate from `silent`: an explicit choice should
   * be remembered, but an automatic downgrade should not. Otherwise one busy
   * moment on the machine pins the user to the lowest preset for good.
   */
  #setQuality(index, { silent = false, persist = true } = {}) {
    this.quality = Math.max(0, Math.min(PRESETS.length - 1, index));
    if (persist) writeStored('murmuration.quality', this.quality);
    const q = PRESETS[this.quality];
    this.renderer.setResolutionScale(q.scale);
    this.renderer.setParticleCount(q.particles);
    $('#quality').textContent = q.name;
    if (!silent) this.#toast(`${q.name} · ${(q.particles / 1000).toFixed(0)}k particles`);
  }

  // ------------------------------------------------------------- input ----

  #wireInput() {
    window.addEventListener('resize', () => {
      this.renderer.resize();
    });

    // Drag, click-burst, wheel zoom and the G flow selector live in the
    // renderer, on the canvas itself. This only feeds the off-canvas fallback
    // position and keeps the chrome awake.
    window.addEventListener('pointermove', (e) => {
      const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
      this.pointer.tx = ((e.clientX / this.canvas.clientWidth) - 0.5) * 2 * aspect;
      this.pointer.ty = (0.5 - (e.clientY / this.canvas.clientHeight)) * 2;
      this.#armIdleTimer();
    });
    this.canvas.addEventListener('pointerdown', () => this.#armIdleTimer());

    // Pinch: the touch equivalent of the wheel, folded into the same target.
    let pinchStart = 0;
    let pinchZoom = 1;
    const spread = (t) => Math.hypot(
      t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) { pinchStart = spread(e.touches); pinchZoom = this.userZoomTarget; }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || pinchStart <= 0) return;
      e.preventDefault();
      const ratio = spread(e.touches) / pinchStart;
      this.userZoomTarget = Math.max(0.68, Math.min(1.75, pinchZoom * ratio));
      this.#armIdleTimer();
    }, { passive: false });

    this.canvas.addEventListener('touchend', () => { pinchStart = 0; });

    // Wheel is the one input the renderer deliberately leaves to us, so it
    // folds into camZoom here rather than being passed as `zoom`.
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const next = this.userZoomTarget * Math.exp(-e.deltaY * 0.0015);
      this.userZoomTarget = Math.max(0.68, Math.min(1.75, next));
      this.#armIdleTimer();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (!this.started) this.#playSong();
          else { this.audio.togglePlay(); this.#syncTransport(); }
          break;
        case 'Enter':
          if (!this.started) this.#playSong();
          break;
        case 'KeyH':
          document.body.classList.toggle('chrome-hidden');
          break;
        case 'KeyF':
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
          break;
        case 'KeyR':
          this.renderer.reseed();
          this.seedTime = Math.random() * 1000;
          break;
        case 'Digit0':
          this.userZoomTarget = 1;
          this.#toast('zoom reset');
          break;
        case 'KeyM':
          this.#useMic();
          break;
        case 'Minus':
        case 'NumpadSubtract':
          this.#setSensitivity(this.sensitivity - 0.2);
          break;
        case 'Equal':
        case 'NumpadAdd':
          this.#setSensitivity(this.sensitivity + 0.2);
          break;
        case 'Backslash':
          this.#setSensitivity(1);
          break;
        case 'KeyV':
          this.#cycleStyle(e.shiftKey ? -1 : 1);
          break;
        case 'KeyB':
          this.modeIndex = (this.modeIndex + 1) % MODES.length;
          writeStored('murmuration.mode', this.modeIndex);
          $('#mode').textContent = MODES[this.modeIndex];
          this.#toast(MODES[this.modeIndex]);
          break;
        case 'Digit1': this.#setQuality(0); break;
        case 'Digit2': this.#setQuality(1); break;
        case 'Digit3': this.#setQuality(2); break;
        default: break;
      }
    });
  }

  // -------------------------------------------------------------- loop ----

  #loop = (now) => {
    requestAnimationFrame(this.#loop);

    const raw = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.min(raw, 1 / 20);
    this.time += dt;

    this.fps += ((1 / Math.max(raw, 1e-4)) - this.fps) * 0.06;
    this.#autoScale();

    this.audio.analyse(dt);
    this.#updateMusicality(dt);
    this.#updateComposition(dt);
    this.style += (this.styleIndex - this.style) * Math.min(1, dt * 2.2);
    this.#updateCamera(dt);

    const a = this.audio;
    const m = a.music ?? EMPTY_MUSIC;
    // Shaders apply their own decay envelope; pass the raw impulse through.
    const beatPulse = a.beat * Math.exp(-a.beatAge * 3.0);
    const sens = this.sensitivity;
    const transientSens = Math.pow(sens, 0.6);
    const spectrum = this.#scaleSpectrum(a.spectrum, sens);
    const voyage = this.modeIndex === 1;
    this.#updateVoyage(dt, spectrum);
    const preset = PRESETS[this.quality];

    this.renderer.frame({
      time: this.time,
      dt,
      bass: Math.min(1.4, a.bass * sens),
      lowMid: Math.min(1.4, a.lowMid * sens),
      mid: Math.min(1.4, a.mid * sens),
      high: Math.min(1.4, a.high * sens),
      level: Math.min(1.3, a.level * sens),
      // Transients scale more gently than sustained level: they drive the
      // brightest moments, and the user has already told me once that the
      // light pulses were too strong.
      beat: a.beat * transientSens,
      beatAge: a.beatAge,
      flux: a.flux * sens,
      // The flight reads a slower envelope: lights that flickered at the
      // analyser's own attack looked nervous, not lit.
      spectrum: voyage ? this.voyageSpectrum : spectrum,
      camZoom: this.cam.zoom,
      camAngle: this.cam.angle,
      camX: this.cam.x,
      camY: this.cam.y,
      pointerX: this.pointer.x,
      pointerY: this.pointer.y,
      seedTime: this.seedTime,
      // Exposure and bloom deliberately do NOT take the full multiplier -
      // sensitivity should make the field move more, not glare more. The
      // flight is graded quieter still: fixed, restrained, almost no grain.
      exposure: voyage
        ? 1.04 + Math.min(0.10, a.level * 0.08)
        : 1.10 + Math.min(0.34, a.level * 0.18 * sens),
      bloomStrength: voyage
        ? Math.min(0.78, 0.62 + a.level * 0.12)
        : 0.72 + Math.min(0.55, a.level * 0.34 * sens) + beatPulse * 0.19 * transientSens,
      grain: voyage ? 0.006 : 0.016,
      speedScale: Math.pow(sens, 0.8),
      sizeScale: 1,
      warmth: this.warmth,
      mood: this.mood,
      flowMode: this.flowMode,
      // Styles are particle treatments; the grade they carry (bloom, contrast)
      // would otherwise leak into the flight.
      style: this.modeIndex === 1 ? 0 : this.style,
      mode: this.modeIndex,
      voyageZ: this.voyage.z,
      voyageSpeed: this.voyage.speed,
      voyageYaw: this.voyage.yaw,
      voyagePitch: this.voyage.pitch,
      voyageRoll: this.voyage.roll,
      voyageFocus: this.voyage.focus,
      voyageAperture: this.voyage.aperture,
      voyageLights: preset.lights,
      voyageSky: preset.sky,
      composeCentreX: this.compose.x,
      composeCentreY: this.compose.y,
      composeStretch: this.compose.stretch,
      composeAngle: this.compose.angle,
      composeSplit: this.compose.split,
      tempo: m.tempo,
      tempoConfidence: m.tempoConfidence,
      beatPhase: m.beatPhase,
      musicalMode: m.mode * m.modeConfidence,
      onset: m.onset * transientSens,
      density: m.density,
      lull: m.lull,
      breath: m.breath,
      entry: m.entry * transientSens,
      pitch: m.pitch,
      pitchCents: m.pitchCents,
      pitchConfidence: m.pitchConfidence,
      voice: m.voice,
      voiceConfidence: m.voiceConfidence,
      attack: Math.min(1.3, m.attack * sens),
      percussiveness: m.percussiveness,
      bandAttack: m.bandAttack,
      bandSustain: m.bandSustain,
    });

    this.#drawRibbon();
    this.#updateHud();
  };

  #autoScale() {
    if (this.autoScaled || !this.started || this.quality === 0) return;
    if (this.time < 4) return;
    this.slowFrames = this.fps < 34 ? this.slowFrames + 1 : 0;
    if (this.slowFrames > 300) {
      this.autoScaled = true;
      this.#setQuality(this.quality - 1, { persist: false });
      this.#toast('eased quality for this session');
    }
  }

  /**
   * Turns what the music is doing into where the piece sits tonally.
   *
   * Major keys travel up the warm half of the palette bank and minor keys sink
   * into the cold half, so colour follows the harmony rather than a script.
   * Density picks the flow behaviour: sparse passages get laminar sheets, busy
   * ones get braids and rays.
   */
  #updateMusicality(dt) {
    const m = this.audio.music;
    if (!m) return;

    // Mode sets the centre of gravity - minor toward the cold banks, major
    // toward the warm ones - but it cannot be the whole story. A track that
    // stays in one mode for three minutes would then sit in one palette for
    // three minutes, which is what happened: on the flagship track mood moved
    // only between 2.43 and 2.72 from end to end. Energy and a slow swing on
    // incommensurate periods carry it across the banks regardless, so the
    // colour still travels within the half the harmony has chosen.
    // Folded rather than clamped. Clamping looks reasonable and is not: push a
    // minor track's centre of gravity toward the cold end and the swing simply
    // runs into the ceiling, pinning the palette at one bank permanently -
    // worse than what it replaced. Folding reflects back off the ends, so the
    // journey continues no matter where the harmony puts the centre.
    const tonal = m.mode * m.modeConfidence;
    const centre = 2.0 - tonal * 0.7;
    const swing = Math.sin(this.time * 0.0091) * 0.70
                + Math.sin(this.time * 0.0037 + 2.1) * 0.45;
    const energy = (m.density - 0.5) * 0.9;
    const moodTarget = foldRange(centre + swing + energy - m.lull * 0.6, 4);
    this.mood += (moodTarget - this.mood) * Math.min(1, dt * 0.35);

    const flowTarget = 3 - clamp(m.density * 3.4, 0, 3);
    this.flowMode += (flowTarget - this.flowMode) * Math.min(1, dt * 0.25);

    // The breath: the field opens out and slows as the music rests.
    const target = 1 - m.lull * 0.16 + m.breath * 0.05;
    this.breathScale += (target - this.breathScale) * Math.min(1, dt * 1.2);
  }

  /**
   * Where the mass sits in frame, and what shape it takes.
   *
   * Without this the field is pinned to the origin and every minute looks like
   * the last one. The periods are deliberately incommensurate, so the drift
   * does not visibly repeat, and the music decides how far it is willing to
   * travel: a dense passage throws the mass off centre and may break it into
   * two, a lull draws it back to the middle and rounds it out.
   */
  /** Scaled copy, so the engine's own readings stay honest for the HUD. */
  #scaleSpectrum(spectrum, sens) {
    if (sens === 1) return spectrum;
    const out = this.scaledSpectrum;
    for (let i = 0; i < spectrum.length; i++) out[i] = Math.min(1.5, spectrum[i] * sens);
    return out;
  }

  #cycleStyle(step) {
    this.styleIndex = (this.styleIndex + step + STYLES.length) % STYLES.length;
    writeStored('murmuration.style', this.styleIndex);
    $('#style').textContent = STYLES[this.styleIndex];
    $('#mode').textContent = MODES[this.modeIndex];
    this.#toast(STYLES[this.styleIndex]);
  }

  #setSensitivity(value) {
    this.sensitivity = clamp(Math.round(value * 10) / 10, 0.4, 3);
    writeStored('murmuration.sensitivity', this.sensitivity);
    $('#sensitivity').textContent = `sens ${this.sensitivity.toFixed(1)}x`;
    this.#toast(`sensitivity ${this.sensitivity.toFixed(1)}x`);
  }

  /**
   * The flight itself. Distance is accumulated on the CPU so the shader never
   * has to integrate, and so a lull can genuinely slow the travel rather than
   * just dimming what is already rushing past. Every parameter is eased here:
   * nothing in the flight is allowed to snap.
   */
  #updateVoyage(dt, spectrum) {
    const m = this.audio.music ?? EMPTY_MUSIC;
    const a = this.audio;
    const v = this.voyage;
    // Frame-rate independent first-order smoothing, by time constant.
    const tau = (seconds) => 1 - Math.exp(-dt / seconds);

    // A slower envelope for the lights than the analyser's own: attack in a
    // tenth of a second, release over half of one.
    const vs = this.voyageSpectrum;
    const up = tau(0.10);
    const down = tau(0.55);
    for (let i = 0; i < vs.length; i++) {
      const s = spectrum[i];
      vs[i] += (s - vs[i]) * (s > vs[i] ? up : down);
    }

    // Cruise, plus what the music adds. The lull brakes hard: coasting to a
    // near stop is the whole point of a quiet passage in a flight. Braking is
    // quicker than accelerating, as it is in anything that actually moves.
    const sens = Math.pow(this.sensitivity, 0.55);
    const target = clamp(
      (2.2 + m.density * 5.3 + a.level * 1.8) * (1 - m.lull * 0.78) * sens, 0.45, 10.5);
    v.speed += (target - v.speed) * tau(target < v.speed ? 1.8 : 3.0);
    // The path and the field are both periodic in this, so wrapping is
    // invisible and keeps the shader's float precision intact.
    v.z = (v.z + v.speed * dt) % 12288;

    // Pitch steers, but relatively: a line that rises above where it has been
    // sitting turns the gaze, not the absolute note. Absolute pitch would
    // pin the camera to one side for a whole song in a high key.
    if (m.pitchConfidence > 0.25 && m.pitch > 20) {
      const lp = Math.log2(m.pitch);
      if (v.pitchLong === 0) { v.pitchLong = lp; v.pitchShort = lp; }
      v.pitchShort += (lp - v.pitchShort) * tau(0.45);
      v.pitchLong += (lp - v.pitchLong) * tau(4.0);
    }
    const conf = m.pitchConfidence;
    const steerTarget = clamp((v.pitchShort - v.pitchLong) / 0.5, -1, 1) * conf * conf;
    v.steer += (steerTarget - v.steer)
             * tau(Math.abs(steerTarget) > Math.abs(v.steer) ? 1.8 : 3.0);

    // The gaze. Eased and rate-limited: nothing here may ever be quick.
    const t = this.time;
    const tonal = m.mode * m.modeConfidence;
    const yawTarget = v.steer * 0.035 + this.pointer.x * 0.03 + Math.sin(t * 0.041) * 0.03;
    const pitchTarget = tonal * 0.02 + this.pointer.y * 0.02 + Math.sin(t * 0.029 + 1.0) * 0.02;
    const rollTarget = -v.steer * 0.0105 + Math.sin(t * 0.019) * 0.0087;
    v.yaw = approach(v.yaw, yawTarget, tau(2.0), 0.0157 * dt);
    v.pitch = approach(v.pitch, pitchTarget, tau(2.0), 0.0096 * dt);
    v.roll = approach(v.roll, rollTarget, tau(2.5), 0.021 * dt);

    // Optics breathe with the music instead of the camera moving: a quiet
    // passage settles the eye further ahead and opens the aperture a touch.
    // Focus sits far out, so the lanterns of the middle distance are soft orbs
    // and only the far field is crisp.
    const focusTarget = 30 + m.breath * 4 + m.lull * 6;
    v.focus += (focusTarget - v.focus) * tau(2.0);
    const apertureTarget = 1 + a.bass * 0.08 + m.breath * 0.08;
    v.aperture += (apertureTarget - v.aperture) * tau(0.5);
  }

  #updateComposition(dt) {
    const t = this.time;
    const m = this.audio.music ?? EMPTY_MUSIC;
    const ease = (rate) => Math.min(1, dt * rate);

    const reach = clamp(0.20 + m.density * 0.80 - m.lull * 0.55, 0, 1);
    const driftX = Math.sin(t * 0.0131) * 0.52 + Math.sin(t * 0.0077 + 1.7) * 0.28;
    const driftY = Math.cos(t * 0.0109) * 0.30 + Math.sin(t * 0.0061 + 0.4) * 0.18;
    this.compose.x += (driftX * reach - this.compose.x) * ease(0.30);
    this.compose.y += (driftY * reach - this.compose.y) * ease(0.30);

    const stretch = (Math.sin(t * 0.0089) * 0.5 + 0.5) * (0.10 + m.density * 0.60);
    this.compose.stretch += (stretch - this.compose.stretch) * ease(0.22);
    this.compose.angle = Math.sin(t * 0.0043) * Math.PI;

    // Squared so the field spends most of its time whole and only occasionally
    // separates - a split that is always half-present just reads as a smear.
    const lobe = Math.max(0, Math.sin(t * 0.0057 - 1.1)) ** 2;
    const split = lobe * clamp(m.density * 1.1 - m.lull, 0, 1);
    this.compose.split += (split - this.compose.split) * ease(0.18);
  }

  #updateCamera(dt) {
    const a = this.audio;
    const t = this.time;

    this.pointer.x += (this.pointer.tx - this.pointer.x) * Math.min(1, dt * 3.2);
    this.pointer.y += (this.pointer.ty - this.pointer.y) * Math.min(1, dt * 3.2);

    this.cam.punch += (0 - this.cam.punch) * Math.min(1, dt * 4.5);
    if (a.beatAge < dt * 1.5) this.cam.punch = Math.min(0.06, 0.018 + a.beat * 0.022);

    this.userZoom += (this.userZoomTarget - this.userZoom) * Math.min(1, dt * 4.5);
    const zoomTarget = (1 + Math.sin(t * 0.021) * 0.055 - a.level * 0.05
      + this.cam.punch) * this.userZoom * this.breathScale;
    this.cam.zoom += (zoomTarget - this.cam.zoom) * Math.min(1, dt * 2.4);

    this.cam.angle = Math.sin(t * 0.0163) * 0.026 + Math.sin(t * 0.0071) * 0.014;
    this.cam.x = Math.sin(t * 0.0371) * 0.075 + this.pointer.x * 0.02;
    this.cam.y = Math.cos(t * 0.0293) * 0.055 + this.pointer.y * 0.02;

    // Palette drifts warm through the choruses and cools back down after.
    const warmTarget = Math.min(1, a.level * 1.6 + a.high * 0.9);
    this.warmth += (warmTarget - this.warmth) * Math.min(1, dt * 0.55);
  }

  #drawRibbon() {
    const c = this.spectrumCanvas;
    const ctx = this.ribbonCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const spec = this.audio.spectrum;
    const n = spec.length;
    const bw = w / n;
    const mid = h / 2;

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(92,190,208,0.72)');
    grad.addColorStop(0.55, 'rgba(180,225,225,0.78)');
    grad.addColorStop(1, 'rgba(255,178,120,0.78)');
    ctx.fillStyle = grad;

    const bar = Math.max(1, bw - 1.8);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.5, Math.pow(spec[i], 0.9) * (h * 0.38));
      ctx.fillRect(i * bw, mid - v, bar, v * 2);
    }
  }

  #updateHud() {
    if (!this.started) return;
    const a = this.audio;
    if (a.mode === 'file' && a.duration > 0) {
      const f = a.currentTime / a.duration;
      $('#progress-fill').style.transform = `scaleX(${f})`;
      $('#time').textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
    } else {
      $('#time').textContent = fmt(this.time);
    }
    $('#fps').textContent = `${Math.round(this.fps)} fps`;
  }
}

/**
 * Preferences survive a reload, but a browser that refuses storage (private
 * windows, blocked site data) must not take the piece down with it.
 */
function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;      // Number(null) is 0, so test first
    const v = Number(raw);
    return Number.isFinite(v) ? v : fallback;
  } catch { return fallback; }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* not available */ }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Eases toward a target, never moving more than `maxStep` in one call. */
function approach(current, target, k, maxStep) {
  return current + clamp((target - current) * k, -maxStep, maxStep);
}

/** Reflects a value back into [0, span] instead of clipping at the ends. */
function foldRange(v, span) {
  const period = span * 2;
  const m = ((v % period) + period) % period;
  return m <= span ? m : period - m;
}

/** Stand-in before an AudioContext exists, so the frame loop stays branch-free. */
const EMPTY_BANDS = new Float32Array(6);
const EMPTY_MUSIC = {
  tempo: 0, tempoConfidence: 0, beatPhase: 0, mode: 0, modeConfidence: 0,
  onset: 0, density: 0, lull: 0, breath: 0, entry: 0,
  voice: 0, voiceConfidence: 0, attack: 0, percussiveness: 0,
  pitch: 0, pitchCents: 0, pitchConfidence: 0,
  bandAttack: EMPTY_BANDS, bandSustain: EMPTY_BANDS,
};

function fmt(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const app = new App();
// Exposed so the field can be poked from the console: viz.audio, viz.renderer.
window.viz = app;
app.start();
