import { Renderer, SPECTRUM_BINS } from './renderer.js';
import { AudioEngine } from './audio.js';
import { SONG } from './song.js';
import { MusicAnalysis } from './analysis.js';
import { SoundCloud } from './soundcloud.js';
import { SOUNDCLOUD } from './config.js';

// `lights` and `sky` are the voyage populations; sparse is the point there,
// so lavish buys detail in the distance rather than a denser field.
const QUALITY = [
  { name: 'calm',    particles: 260000, scale: 0.85, lights: 4096, sky: 384, sheets: 2, strands: 220, grains: 220000 },
  { name: 'full',    particles: 620000, scale: 1.00, lights: 8192, sky: 768, sheets: 3, strands: 288, grains: 420000 },
  { name: 'lavish',  particles: 1200000, scale: 1.00, lights: 12288, sky: 1152, sheets: 3, strands: 384, grains: 700000 },
];

// A phone GPU will not carry the desktop particle counts, but it must still
// render at native resolution: trimming pixels means upscaling a small buffer
// onto a 3x screen, and the grains go soft. Pixels buy crispness, particles
// buy density - so on a handheld, spend on pixels and cut the particles.
const TOUCH = matchMedia('(pointer: coarse)').matches;
const SMALL = Math.min(window.innerWidth, window.innerHeight) < 700;
const HANDHELD = TOUCH && SMALL;

const HANDHELD_QUALITY = [
  { name: 'calm',   particles: 110000, scale: 1, lights: 2048, sky: 256, sheets: 2, strands: 160, grains: 120000 },
  { name: 'full',   particles: 240000, scale: 1, lights: 4096, sky: 384, sheets: 2, strands: 200, grains: 200000 },
  { name: 'lavish', particles: 460000, scale: 1, lights: 6144, sky: 576, sheets: 3, strands: 260, grains: 300000 },
];
const PRESETS = HANDHELD ? HANDHELD_QUALITY : QUALITY;

// Treatment, not signal: a style changes how a grain is drawn, while mood
// still chooses the palette and flowMode still chooses the motion.
const STYLES = ['nebula', 'ink', 'constellation', 'ribbon', 'etching'];
// Modes are whole rendering approaches, not treatments. Particle is the
// simulation; voyage is a raymarch you fly through.
// The particles are the piece. The flights and the plate stay in the code
// to be worked on, and come back into the cycle with `?modes=all` (or
// `murmuration.modes` = `all` in localStorage).
const ALL_MODES = ['particle', 'voyage', 'current', 'plate'];
const MODES = (new URLSearchParams(location.search).get('modes') === 'all' || readText('murmuration.modes') === 'all')
  ? ALL_MODES : ['particle'];

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
    // The mode is deliberately not remembered: the piece opens on the
    // particles, and the other modes are somewhere to go from there.
    this.modeIndex = 0;
    // The flight begins somewhere along its period, so no two loads open on
    // the same lights.
    this.voyage = {
      z: Math.random() * 12288, speed: 0, yaw: 0, pitch: 0, roll: 0, focus: 30, aperture: 1,
      mood: 0,
      pitchShort: 0, pitchLong: 0, steer: 0,
      energy: 0, energySlow: 0, turnDir: 1, steerAvg: 0,
      breathArmed: true, breathT: 10, breathLen: 6, breathAmp: 0,
      bassEnv: 0, midEnv: 0, highEnv: 0, voiceFast: 0, voiceSlow: 0, voiceEntrance: 0,
      entryAge: 99, entryArmed: true, vocalAge: 99, vocalArmed: true, vocalWarm: 0,
      energySection: 0, energyBaseline: 0, chorus: 0,
      yawRate: 0, pitchRate: 0, rollRate: 0, swell: 0,
    };
    this.voyageSpectrum = new Float32Array(SPECTRUM_BINS);
    this.soundcloud = new SoundCloud(SOUNDCLOUD);
    this.streamWarned = false;
    this.wakeLock = null;
    // The sculpture: the music's hold on the form. Its camera is the
    // flight's. The evolution clock starts somewhere, so no two loads open
    // on the same fold.
    const band = () => ({ e: 0, lo: 0, hi: 0.08 });
    this.sculpt = {
      bass: band(), mid: band(), high: band(), level: band(), fast: band(),
      bassSlow: 0, midSlow: 0, highSlow: 0, phrase: 0,
      evolution: Math.random() * 1000, flow: 0,
      pulses: [{ pos: 0, amp: 0 }, { pos: 0, amp: 0 }, { pos: 0, amp: 0 }], refractory: 0, midArmed: true, onsetArmed: true,
      speedEnv: 0, flowRate: 2, stations: new Map(), kStart: 0,
      entry: { pos: 0, amp: 0 }, entryArmed: true,
    };
    this.sculptUniforms = new Float32Array(28);
    // The plate's data for the GPU, laid out by its update.
    this.modeData = new Float32Array(4096);
    this.plate = {
      smooth: new Float32Array(SPECTRUM_BINS),
      slots: Array.from({ length: 4 }, () => ({ bin: -99, mode: PLATE_MODES[0], sym: 0.6, amp: 0, target: 0, seen: false, oldMode: PLATE_MODES[0], oldSym: 0.6, oldAmp: 0 })),
      agitation: 0, kick: 0, hop: 0, bassSlow: 0, diffusion: 1, pendingBin: -99, pendingFor: 0,
    };
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
    this.#resumeSoundCloud();

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
    $('#btn-capture').addEventListener('click', () => this.#begin(() => this.audio.captureTab()));
    $('#btn-soundcloud').addEventListener('click', () => this.#toggleSoundCloud());
    $('#sc-play').addEventListener('click', () => this.#playSoundCloud($('#sc-url').value.trim()));
    $('#sc-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.#playSoundCloud(e.target.value.trim()); });
    $('#sc-connect').addEventListener('click', () => this.#connectSoundCloud());
    $('#sc-disconnect').addEventListener('click', () => { this.soundcloud.disconnect(); this.#syncSoundCloud(); });
    if (MODES.length < 2) $('#keys-mode').hidden = true;

    $('#file-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this.#begin(() => this.audio.playFile(file));
    });

    $('#transport').addEventListener('click', () => {
      this.audio.togglePlay();
      this.#syncTransport();
    });
    // The browser drops the wake lock whenever the tab is hidden; it is
    // taken again when the tab comes back, if the music is still playing.
    document.addEventListener('visibilitychange', () => this.#syncWakeLock());

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

  // -- SoundCloud ----------------------------------------------------------------

  #toggleSoundCloud() {
    const panel = $('#sc-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { this.#syncSoundCloud(); $('#sc-url').focus(); }
  }

  /** The panel's state line and which of its controls show. */
  async #syncSoundCloud() {
    const sc = this.soundcloud;
    const status = $('#sc-status');
    $('#sc-connect').hidden = !sc.configured || sc.connected;
    $('#sc-disconnect').hidden = !sc.connected;
    $('#sc-play').disabled = !sc.connected;
    if (!sc.configured) {
      status.textContent = 'needs a SoundCloud app id - see src/config.js - or capture a tab instead';
      return;
    }
    if (!sc.connected && !sc.canExchange) {
      $('#sc-connect').hidden = true;
      status.textContent = 'needs the token proxy to finish a sign-in - see src/config.js - or capture a tab instead';
      return;
    }
    if (!sc.connected) { status.textContent = 'connect to play a track from SoundCloud'; return; }
    status.textContent = 'connected';
    try {
      const me = await sc.me();
      if (me?.username) status.textContent = `connected as ${me.username}`;
    } catch (err) {
      status.textContent = err.message;
    }
  }

  async #connectSoundCloud() {
    try {
      await this.soundcloud.connect($('#sc-url').value.trim());
    } catch (err) {
      this.#toast(err.message);
    }
  }

  /** Resolves a SoundCloud link, checks it may be streamed, plays it. */
  async #playSoundCloud(url) {
    if (!url) { $('#sc-url').focus(); return; }
    const sc = this.soundcloud;
    if (!sc.connected) { this.#connectSoundCloud(); return; }
    const btn = $('#sc-play');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      const track = await sc.resolve(url);
      if (track.access !== 'playable') {
        throw new Error(track.access === 'preview'
          ? 'SoundCloud offers only a preview of that track off-platform - capture a tab instead'
          : 'that track cannot be streamed off SoundCloud - capture a tab instead');
      }
      const streamUrl = SoundCloud.pickStream(await sc.streams(track.id));
      if (!streamUrl) throw new Error('no stream this browser can play - capture a tab instead');
      const credit = SoundCloud.attribution(track);
      await this.#begin(() => this.audio.playStream(streamUrl, `${credit.title} · ${credit.artist}`, credit));
      this.streamWarned = false;
    } catch (err) {
      this.#toast(err.message || String(err));
    } finally {
      btn.classList.remove('loading');
      btn.disabled = !sc.connected;
    }
  }

  /** Finishes a sign-in on the way back from SoundCloud, if this is one.
   *  Whatever happens shows in the panel, which stays open. */
  async #resumeSoundCloud() {
    if (!new URLSearchParams(location.search).has('code')) return;
    $('#sc-panel').hidden = false;
    try {
      const pending = await this.soundcloud.handleRedirect();
      if (pending) $('#sc-url').value = pending;
      await this.#syncSoundCloud();
    } catch (err) {
      $('#sc-status').textContent = err.message;
      this.#toast(err.message);
    }
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
    // What SoundCloud's terms ask of a custom player: the uploader, the
    // source, a link to the track.
    const credit = this.audio.streamMeta;
    const link = $('#track-link');
    link.hidden = !credit;
    if (credit) { link.href = credit.trackUrl; link.textContent = `${credit.artist} on SoundCloud`; }
    $('#progress').classList.toggle('hidden', !this.audio.seekable);
    this.#syncTransport();
    this.#armIdleTimer();
  }

  #syncTransport() {
    $('#transport').classList.toggle('paused', !this.audio.playing);
    this.#syncWakeLock();
  }

  /**
   * Keeps the screen awake while the music plays, the way a video does:
   * a screen wake lock, held while playing and visible, released when
   * paused. Needs a secure context (https, or localhost) and a browser
   * that has the API; anywhere else this is a quiet no-op.
   */
  async #syncWakeLock() {
    const want = this.started && this.audio.playing && document.visibilityState === 'visible';
    if (want && !this.wakeLock && navigator.wakeLock) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
        this.wakeLock = lock;
      } catch {
        // Denied (battery saver, an insecure page): the piece plays regardless.
      }
    } else if (!want && this.wakeLock) {
      const lock = this.wakeLock;
      this.wakeLock = null;
      lock.release().catch(() => {});
    }
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
    // Both flights share the camera, the grade and the slow spectrum.
    const voyage = this.modeIndex === 1 || this.modeIndex === 2;
    const current = this.modeIndex === 2;
    const still = this.modeIndex >= 3;
    this.#updateVoyage(dt, spectrum);
    this.#updateSculpture(dt);
    if (this.modeIndex === 3) this.#updatePlate(dt);
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
      // The sculpture's grade barely moves: the music travels through the
      // form, it never flashes the frame.
      exposure: still
        ? 1.0
        : current
          ? 1.03 + 0.05 * this.sculpt.phrase
          : voyage
            ? 1.04 + Math.min(0.10, a.level * 0.08)
            : 1.10 + Math.min(0.34, a.level * 0.18 * sens),
      bloomStrength: still
        ? 0.04
        : current
          ? 0.26 + 0.08 * this.sculpt.phrase
          : voyage
            ? Math.min(0.62, 0.44 + a.level * 0.16 + beatPulse * 0.05)
            : 0.72 + Math.min(0.55, a.level * 0.34 * sens) + beatPulse * 0.19 * transientSens,
      grain: still ? 0.004 : current ? 0.0035 : voyage ? 0.006 : 0.016,
      speedScale: Math.pow(sens, 0.8),
      sizeScale: 1,
      warmth: this.warmth,
      mood: voyage ? this.voyage.mood : this.mood,
      flowMode: this.flowMode,
      // Styles are particle treatments; the grade they carry (bloom, contrast)
      // would otherwise leak into the flight.
      style: voyage ? 0 : this.style,
      mode: this.modeIndex,
      voyageZ: this.voyage.z,
      voyageZoom: this.userZoom,
      voyageSpeed: this.voyage.speed,
      voyageYaw: 0.28 * Math.tanh(this.voyage.yaw / 0.28),
      voyagePitch: 0.2 * Math.tanh(this.voyage.pitch / 0.2),
      voyageRoll: this.voyage.roll,
      voyageFocus: this.voyage.focus,
      voyageAperture: this.voyage.aperture,
      voyageYawRate: this.voyage.yawRate,
      voyagePitchRate: this.voyage.pitchRate,
      voyageRollRate: this.voyage.rollRate,
      voyageSwell: this.voyage.chorus,
      voyageLights: preset.lights,
      voyageSky: preset.sky,
      sculpt: this.sculptUniforms,
      currentStrands: current ? preset.sheets * preset.strands : 0,
      modeData: still ? this.modeData : null,
      plateGrains: still ? preset.grains : 0,
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
    // quarter of a second, release over a second. At the analyser's own
    // attack the field looked nervous, not lit.
    const vs = this.voyageSpectrum;
    const up = tau(0.25);
    const down = tau(1.2);
    for (let i = 0; i < vs.length; i++) {
      const s = spectrum[i];
      vs[i] += (s - vs[i]) * (s > vs[i] ? up : down);
    }
    // The palette drifts far more slowly than in particle mode. A lull ending
    // can move the mood a sixth of a bank in a second, which turns every cool
    // light from grey-blue to purple between one breath and the next.
    v.mood += (this.mood - v.mood) * tau(12);

    // Cruise, plus what the music adds. The lull brakes hard: coasting to a
    // near stop is the whole point of a quiet passage in a flight. Braking is
    // quicker than accelerating, as it is in anything that actually moves.
    // Phrase energy: what the music is doing over the last few seconds, and
    // whether it is rising or falling. Rising is an inhale, falling an
    // exhale, and the flight breathes with it.
    const raw = clamp(a.level * 0.7 + m.density * 0.5, 0, 1.2);
    v.energy += (raw - v.energy) * tau(2.5);
    v.energySlow += (v.energy - v.energySlow) * tau(8.5);
    const swell = clamp((v.energy - v.energySlow) * 3.4, -1, 1);
    v.swell = swell;
    // And at the scale of sections: a chorus is a stretch that sits well
    // above the last half-minute's baseline. The lights hold larger through
    // it, eased in and out over a few seconds.
    v.energySection += (v.energy - v.energySection) * tau(4.0);
    v.energyBaseline += (v.energy - v.energyBaseline) * tau(24.0);
    const chorusTarget = clamp((v.energySection - v.energyBaseline) * 3, 0, 1);
    v.chorus += (chorusTarget - v.chorus) * tau(chorusTarget > v.chorus ? 2.5 : 4.0);

    // Speed swells with the inhale and sinks with the exhale - the swell term
    // is signed, so an exhale is felt and not merely the absence of an
    // inhale - and brakes most of the way to a stop once a lull is well
    // established, so the trails grow and shrink with the music. Fast
    // enough that they read as trails.
    // The sculpture flies slower: its rolls are eighty units apart and a
    // pass through one should take a breath, not a blink.
    const sens = Math.pow(this.sensitivity, 0.55);
    const brake = 1 - smoothstep01(m.lull / 0.7) * 0.9;
    const current = this.modeIndex === 2;
    // The sculpture's speed is the phrase, unmistakably: from the
    // adaptively normalised envelope through its own attack and release,
    // never below a walking pace even in a lull.
    const target = current
      ? Math.max(4, clamp((4 + this.sculpt.speedEnv * 18 + swell * 3) * brake * sens, 4, 22))
      : clamp((6 + v.energy * 18 + swell * 6) * brake * sens, 2, 30);
    // The sculpture's speed follows through a critically damped spring, so
    // its accelerations are continuous: a first-order ease reached its
    // target with a kink, and the strands going past showed it.
    if (current) spring(v, 'speed', target, 4.5, dt);
    else v.speed += (target - v.speed) * tau(target < v.speed ? 3.2 : 2.8);
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
             * tau(Math.abs(steerTarget) > Math.abs(v.steer) ? 2.5 : 4.0);

    // The turn. A new inhale picks a direction - the way the melody is
    // leaning, else the other way from last time - and the camera sweeps
    // into it for as long as the swell lasts; the exhale lets it straighten
    // out. Turn rate is what is driven, never heading, and its own
    // acceleration is capped, so the sweep begins and ends the way a real
    // one does. A weak spring keeps the gaze from drifting off the field.
    const t = this.time;
    const tonal = m.mode * m.modeConfidence;
    // The direction: where the melody has been leaning lately; failing that,
    // back toward the middle if the gaze is well off it; failing that, the
    // other way from last time. Armed only once the previous breath has
    // clearly ended, so a wobble in the energy cannot fire it twice.
    // A breath is a sweep of a few seconds that ends on its own: a sine
    // window on the turn rate, so it starts and finishes at rest. Driving
    // the turn for as long as the swell lasted parked the heading against
    // its limit through a whole rising passage.
    v.steerAvg += (v.steer - v.steerAvg) * tau(1.5);
    v.breathT += dt;
    // Re-armed once the energy has eased, or after a pause anyway: through a
    // long crescendo one still breathes.
    if (swell < 0.12 || v.breathT > v.breathLen + 6) v.breathArmed = true;
    // An instrument arriving is a breath of its own.
    if (v.breathArmed && (swell > 0.25 || m.entry > 0.6) && v.breathT > v.breathLen) {
      v.breathArmed = false;
      v.breathT = 0;
      v.breathAmp = 0.65 + 0.6 * clamp(Math.max(swell, m.entry), 0, 1);
      v.breathLen = 5 + (1 - clamp(v.energy, 0, 1)) * 3;   // calmer music, longer breaths
      if (Math.abs(v.steerAvg) > 0.12) v.turnDir = Math.sign(v.steerAvg);
      else if (Math.abs(v.yaw) > 0.10) v.turnDir = -Math.sign(v.yaw);
      else v.turnDir = -v.turnDir;
    }
    // The rates follow their targets through critically damped springs:
    // S-curves with no straight segments. A rate limit and a hard clamp
    // were tried first and gave a tilt that moved at constant speed,
    // stopped, and moved again.
    // Among the strands the sweeps are gentler: the sheet itself brings
    // the motion, and a wide turn of the head made it lurch.
    const gaze = current ? 0.55 : 1;
    const sweep = Math.sin(Math.PI * Math.min(v.breathT / v.breathLen, 1)) * v.breathAmp * gaze;
    const yawRateTarget = v.turnDir * sweep * 0.06
                        - v.yaw * 0.10 + v.steer * 0.01 + this.pointer.x * 0.01;
    // The pose state is unbounded and integrates its true rate; only the
    // rendered value is soft-limited. Limiting the state itself every frame
    // bled the heading away at a rate the roll then banked into.
    spring(v, 'yawRate', yawRateTarget, 2.5, dt);
    v.yaw += v.yawRate * dt;
    const pitchRateTarget = swell * 0.02 * gaze - v.pitch * 0.08 + tonal * 0.005 + this.pointer.y * 0.006;
    spring(v, 'pitchRate', pitchRateTarget, 3.0, dt);
    v.pitch += v.pitchRate * dt;
    // Bank leans into the turn in proportion to how fast it is turning.
    const rollTarget = -v.yawRate * 1.3 + Math.sin(t * 0.013) * 0.007;
    spring(v, 'roll', rollTarget, 2.2, dt);
    v.rollRate = v.rollVel;

    // The river. Each musical event has its own axis: the bass swells the
    // core and widens the bed, the mids light the outer lines, the highs
    // glint along a few thin ones, a chorus raises the veils and the arcs,
    // a lull leaves a thin path through black, the voice warms the peach
    // threads and marks its entrance, an instrument's entry launches one
    // wave down the river.
    const follow = (cur, target, attack, release) =>
      cur + (target - cur) * tau(target > cur ? attack : release);
    v.bassEnv = follow(v.bassEnv, clamp(a.bass, 0, 1.2), 0.07, 0.28);
    v.midEnv = follow(v.midEnv, clamp((a.lowMid + a.mid) * 0.6, 0, 1.2), 0.18, 0.8);
    v.highEnv = follow(v.highEnv, clamp(a.high, 0, 1.2), 0.04, 0.18);
    const voice = clamp(m.voice, 0, 1) * clamp(m.voiceConfidence, 0, 1);
    v.voiceFast = follow(v.voiceFast, voice, 0.12, 0.8);
    v.voiceSlow += (voice - v.voiceSlow) * tau(0.9);
    v.voiceEntrance = clamp((v.voiceFast - v.voiceSlow) * 5, 0, 1);
    v.entryAge += dt;
    if (m.entry < 0.3) v.entryArmed = true;
    if (v.entryArmed && m.entry > 0.6 && v.entryAge > 2.5) { v.entryArmed = false; v.entryAge = 0; }
    // A vocal entrance holds its warmth for a couple of seconds, then lets
    // go, rather than tracking the presence itself.
    v.vocalAge += dt;
    if (v.voiceEntrance < 0.2) v.vocalArmed = true;
    if (v.vocalArmed && v.voiceEntrance > 0.5 && v.vocalAge > 4) { v.vocalArmed = false; v.vocalAge = 0; }
    v.vocalWarm = clamp(1 - (v.vocalAge - 1.6) / 0.8, 0, 1) * smoothstep01(v.vocalAge / 0.25);

    // Optics breathe with the music instead of the camera moving: a quiet
    // passage settles the eye further ahead and opens the aperture a touch.
    // Focus sits far out, so the lanterns of the middle distance are soft orbs
    // and only the far field is crisp.
    const focusTarget = 30 + m.breath * 4 + m.lull * 6;
    v.focus += (focusTarget - v.focus) * tau(2.0);
    const apertureTarget = 1 + a.bass * 0.08 + m.breath * 0.08;
    v.aperture += (apertureTarget - v.aperture) * tau(0.5);
  }

  /**
   * The sculpture. The form lives in the shader along the flight path on
   * slow clocks, and the camera is the flight's; this is the music's hold
   * on it - each band normalised adaptively, so a quiet record moves the
   * form as much as a loud one, and the pulses that run away down the
   * strands from the camera.
   */
  #updateSculpture(dt) {
    const a = this.audio;
    const m = a.music ?? EMPTY_MUSIC;
    const c = this.sculpt;
    const v = this.voyage;
    const tau = (seconds) => 1 - Math.exp(-dt / seconds);

    // -- adaptive normalisation ----------------------------------------------
    // Each band's envelope is placed between a floor and a ceiling that
    // track the record: the floor falls quickly and rises slowly, the
    // ceiling rises at once and decays over a quarter of a minute, and a
    // soft curve spends most of the range on the quieter side. Silence is
    // gated on absolute level, so analyser noise never moves the form.
    const gate = smoothstep01((a.level - 0.006) / 0.014);
    const norm = (band, raw, attack, release, minRange) => {
      band.e += (raw - band.e) * tau(raw > band.e ? attack : release);
      const e = band.e;
      band.lo += (e - band.lo) * tau(e < band.lo ? 1.5 : 24);
      band.hi += (e - band.hi) * tau(e > band.hi ? 0.2 : 14);
      const n = clamp((e - band.lo) / Math.max(band.hi - band.lo, minRange), 0, 1.25);
      return clamp((1 - Math.exp(-1.6 * n)) / (1 - Math.exp(-1.6)), 0, 1.1) * gate;
    };
    const bass = norm(c.bass, a.bass, 0.12, 0.9, 0.05);
    const mid = norm(c.mid, (a.lowMid + a.mid) * 0.6, 0.08, 0.55, 0.05);
    const high = norm(c.high, a.high, 0.025, 0.22, 0.035);
    const phrase = norm(c.level, a.level * 0.7 + m.density * 0.5, 2.5, 4.0, 0.05);
    // Smoothed again where they move the form: the curl breathes, it never
    // twitches.
    c.bassSlow += (bass - c.bassSlow) * tau(bass > c.bassSlow ? 0.8 : 2.0);
    c.midSlow += (mid - c.midSlow) * tau(mid > c.midSlow ? 0.15 : 0.8);
    c.highSlow += (high - c.highSlow) * tau(high > c.highSlow ? 0.05 : 0.25);
    c.phrase += (phrase - c.phrase) * tau(1.5);
    // The speed answers within a couple of seconds: a fast normalised
    // level, not the phrase, through a short attack and release.
    const fast = norm(c.fast, a.level * 0.7 + m.density * 0.5, 0.35, 1.2, 0.05);
    c.speedEnv += (fast - c.speedEnv) * tau(fast > c.speedEnv ? 1.0 : 2.0);
    const lull = clamp(m.lull, 0, 1);

    // -- clocks ----------------------------------------------------------------
    // The form evolves a little faster when the music is full and slower in
    // a lull; the light flows along the strands at the mids' pace, and
    // always toward the camera a little, so the strands stream past even
    // when the flight is slow.
    c.evolution += dt * (0.8 + 0.4 * c.phrase) * (1 - 0.4 * lull);
    // The light flowing along the strands: one wave per beat while the
    // tempo is trusted, else at the mids' pace; the rate eases, so a
    // change of pace never jumps the wave.
    const trustNow = m.tempoConfidence * m.tempoConfidence;
    const flowTarget = trustNow > 0.45 && m.tempo > 40
      ? (2 * Math.PI * m.tempo / 60) * (1 - 0.3 * lull)
      : (1.5 + 4.0 * c.midSlow) * (1 - 0.6 * lull);
    c.flowRate += (flowTarget - c.flowRate) * tau(1.0);
    c.flow = (c.flow + dt * c.flowRate) % (2 * Math.PI);

    // -- the rolls ahead -------------------------------------------------------
    // Each roll station closes as much as the music was full when it came
    // into view, a couple of hundred units ahead: a quiet passage flies
    // beside open sweeps, a rising one rolls the sheet shut around the
    // path. A station keeps its closure until it has passed behind.
    // A station's closure follows the music through a spring while the
    // station is still distant, and freezes thirty units before the
    // encounter, so that a full passage closing the roll ahead still reads
    // as cause and effect: decided once at the horizon, it answered music
    // that had ended half a minute before.
    const ROLL_L = 12288 / 120;
    const kStart = Math.floor((v.z - 130) / ROLL_L);
    const kEnd = Math.floor((v.z + 270) / ROLL_L);
    const closureTarget = clamp(0.08 + 0.6 * c.phrase + 0.3 * v.chorus, 0.05, 1.0);
    for (const k of c.stations.keys()) if (k < kStart || k > kEnd) c.stations.delete(k);
    for (let k = kStart; k <= kEnd; k++) {
      let st = c.stations.get(k);
      if (!st) { st = { closure: closureTarget, closureVel: 0, frozen: false }; c.stations.set(k, st); }
      // Against the roll's real centre: the shader shifts each station by
      // a hash of its index, up to a third of the spacing either way.
      if (!st.frozen && (k + rollJitter(k)) * ROLL_L - v.z < 35) st.frozen = true;
      if (!st.frozen) spring(st, 'closure', closureTarget, 2.5, dt);
    }
    c.kStart = kStart;

    // -- pulses ----------------------------------------------------------------
    // A beat launches a pulse away down the sheet from the camera when the
    // tempo is trusted, else an onset or a rising mid does; two may travel
    // at once, only ever into a slot whose pulse has faded - relaunching a
    // bright one would pull it out of the middle of the sheet. An
    // instrument's entrance sends a broader, quicker one. Positions are in
    // path units and wrap with the period.
    const PERIOD = 12288;
    c.refractory = Math.max(0, c.refractory - dt);
    const trust = m.tempoConfidence * m.tempoConfidence;
    const beatNow = a.beatAge < dt * 1.5 && trust > 0.45;
    if (mid < 0.35) c.midArmed = true;
    if (m.onset < 0.25) c.onsetArmed = true;
    const midRise = trust <= 0.45 && mid > 0.6 && c.midArmed;
    const onsetNow = trust <= 0.45 && m.onset > 0.5 && c.onsetArmed;
    let slot = 0;
    for (let i = 1; i < c.pulses.length; i++) if (c.pulses[i].amp < c.pulses[slot].amp) slot = i;
    if ((beatNow || midRise || onsetNow) && c.refractory <= 0 && gate > 0.5 && c.pulses[slot].amp < 0.35) {
      const p = c.pulses[slot];
      p.pos = v.z + 3;
      p.amp = 0.55 + 0.45 * Math.max(mid, bass);
      c.refractory = beatNow ? 0.28 : 0.9;
      c.midArmed = false;
      c.onsetArmed = false;
    }
    for (const p of c.pulses) {
      p.pos = (p.pos + dt * (v.speed + 18 + 12 * c.midSlow)) % PERIOD;
      p.amp *= Math.exp(-dt / 2.0);
    }
    if (m.entry < 0.3) c.entryArmed = true;
    if (c.entryArmed && m.entry > 0.6 && c.entry.amp < 0.05 && gate > 0.5) {
      c.entryArmed = false;
      c.entry.pos = v.z + 2;
      c.entry.amp = 0.7;
    }
    c.entry.pos = (c.entry.pos + dt * (v.speed + 30)) % PERIOD;
    c.entry.amp *= Math.exp(-dt / 3.5);

    // -- uniforms --------------------------------------------------------------
    const preset = PRESETS[this.quality];
    const s = this.sculptUniforms;
    s[0] = c.bassSlow; s[1] = c.midSlow; s[2] = lull; s[3] = c.phrase;
    s[4] = c.flow; s[5] = c.evolution; s[6] = preset.strands; s[7] = preset.sheets;
    s[8] = c.pulses[0].pos; s[9] = c.pulses[0].amp;
    s[10] = c.pulses[1].pos; s[11] = c.pulses[1].amp;
    s[12] = c.entry.pos; s[13] = c.entry.amp;
    // The echo brightens with the phrase and all but goes in a lull; the
    // veil appears only when the music is full.
    s[14] = (0.09 + 0.08 * c.phrase) * (1 - 0.6 * lull);
    s[15] = 0.08 * smoothstep01((c.phrase - 0.7) / 0.3);
    // The light breathes with the bass and fills with the phrase; the
    // warmth: the phrase, the voice, a major key. Never the whole sheet.
    // The light fills with the phrase; the bass is the form's breath, not
    // its brightness.
    s[16] = (0.78 + 0.30 * c.phrase) * (1 - 0.2 * lull);
    s[17] = clamp(0.10 + 0.16 * c.phrase + 0.30 * v.voiceFast + 0.08 * Math.max(m.mode * m.modeConfidence, 0), 0, 0.55) / 0.55;
    s[18] = c.pulses[2].pos; s[19] = c.pulses[2].amp;
    s[20] = c.highSlow;
    s[21] = c.kStart;
    for (let i = 0; i < 6; i++) s[22 + i] = c.stations.get(c.kStart + i)?.closure ?? 0.4;
  }

  /**
   * The plate: sand on a vibrating plate. The strongest few spectral peaks
   * each ring a mode of the plate, chosen by pitch, at an amplitude by
   * energy, adopted with hysteresis and crossfaded over a couple of
   * seconds so the figure never flickers between harmonics. The level sets
   * how mobile the sand is, an onset kicks it, a lull lets it settle crisp.
   */
  #updatePlate(dt) {
    const a = this.audio;
    const m = a.music ?? EMPTY_MUSIC;
    const pl = this.plate;
    const tau = (seconds) => 1 - Math.exp(-dt / seconds);
    const spec = a.spectrum;

    // -- the peaks ---------------------------------------------------------------
    // Smoothed bins between the low strings and the top of the voice, the
    // strongest three that stand above their neighbours, each represented
    // by its lowest likely fundamental.
    const lo = 16; const hi = 100;
    for (let i = lo; i < hi; i++) {
      const v = spec[i];
      pl.smooth[i] += (v - pl.smooth[i]) * tau(v > pl.smooth[i] ? 0.08 : 0.6);
    }
    const peaks = [];
    for (let i = lo + 2; i < hi - 2; i++) {
      const v = pl.smooth[i];
      if (v < 0.05) continue;
      if (v > pl.smooth[i - 1] && v >= pl.smooth[i + 1] && v > pl.smooth[i - 2] && v > pl.smooth[i + 2]) peaks.push([i, v]);
    }
    peaks.sort((x, y) => y[1] - x[1]);
    // Harmonics of a stronger, lower peak fold into it: an octave is this
    // many bins on the analyser's log scale.
    const octave = 128 / Math.log2(16000 / 28);
    const chosen = [];
    for (const [i, v] of peaks) {
      let harmonic = false;
      for (const c of chosen) {
        const d = i - c[0];
        for (const k of [1, 1.585, 2]) if (Math.abs(d - k * octave) < 1.2) harmonic = true;
      }
      if (!harmonic) chosen.push([i, v]);
      if (chosen.length >= 3) break;
    }
    // -- the modes ---------------------------------------------------------------
    // Each mode slot follows a bin; a slot is retaken only by a peak that
    // beats its current one by a third for a while - the same newcomer -
    // and then its old mode fades over a second while the new one rises
    // over a third, so the figure crossfades rather than snaps. Pitch picks
    // the mode at two semitones' resolution, and the symmetry of the pair
    // follows the mode, so the same chord always draws the same figure.
    for (const slot of pl.slots) slot.seen = false;
    const modeFor = (i) => PLATE_MODES[Math.min(PLATE_MODES.length - 1, Math.max(0, Math.floor((i - lo) / (hi - lo) * PLATE_MODES.length)))];
    const symFor = (mode) => ((mode[0] * 7 + mode[1] * 3) % 2 === 0 ? 1 : -1) * (0.45 + 0.35 * (((mode[0] * 5 + mode[1]) % 4) / 3));
    for (const [i, v] of chosen) {
      let slot = pl.slots.find((s) => Math.abs(s.bin - i) <= 1.2 && s.amp > 0.01);
      if (!slot) {
        slot = pl.slots.find((s) => s.amp < 0.02 && s.oldAmp < 0.02) ?? null;
        if (!slot) {
          const weakest = pl.slots.reduce((w, s) => (s.target < w.target ? s : w), pl.slots[0]);
          if (v > weakest.target * 1.35) {
            if (Math.abs(pl.pendingBin - i) <= 1.5) pl.pendingFor += dt; else { pl.pendingBin = i; pl.pendingFor = 0; }
            if (pl.pendingFor > 0.45) { slot = weakest; pl.pendingFor = 0; pl.pendingBin = -99; }
          }
        }
        if (slot) {
          const mode = modeFor(i);
          if (slot.amp >= 0.02) { slot.oldMode = slot.mode; slot.oldSym = slot.sym; slot.oldAmp = slot.amp; slot.amp = 0; }
          slot.bin = i; slot.mode = mode; slot.sym = symFor(mode);
        }
      }
      if (slot) { slot.target = v; slot.seen = true; }
    }
    if (!chosen.some(([i]) => Math.abs(pl.pendingBin - i) <= 1.5)) { pl.pendingBin = -99; pl.pendingFor = 0; }
    for (const slot of pl.slots) {
      if (!slot.seen) slot.target = 0;
      slot.amp += (slot.target - slot.amp) * tau(slot.target > slot.amp ? 0.3 : (slot.seen ? 0.6 : 1.8));
      slot.oldAmp *= Math.exp(-dt / 1.0);
    }
    // -- the sand ----------------------------------------------------------------
    // The bass is a tremor and a breath of the rake light; a beat throws
    // the sand up - it hops off its shadow, larger for an instant - with
    // only a little sideways scatter; a lull calms the tremor by four
    // fifths.
    const gate = smoothstep01((a.level - 0.006) / 0.014);
    pl.agitation += (clamp(a.bass * 0.55 + a.level * 0.45, 0, 1.0) * gate - pl.agitation) * tau(0.2);
    pl.bassSlow += (clamp(a.bass, 0, 1) * gate - pl.bassSlow) * tau(0.6);
    const onset = clamp(m.onset, 0, 1);
    const beat = clamp(a.beat, 0, 1.6) * Math.exp(-a.beatAge * 5);
    pl.kick = Math.max(pl.kick * Math.exp(-dt / 0.18), beat * 0.4, onset > 0.5 ? onset * 0.25 : 0) * gate;
    pl.hop = Math.max(pl.hop * Math.exp(-dt / 0.14), beat * gate);
    const lull = clamp(m.lull, 0, 1);
    pl.diffusion += ((1 - 0.8 * lull) - pl.diffusion) * tau(1.5);

    // The three strongest ring the plate, their old modes fading beside
    // them; amplitudes are normalised so the figure's strength does not
    // depend on how many peaks the music happens to have.
    const M = this.modeData;
    const live = pl.slots.filter((slot) => slot.amp >= 0.01).sort((x, y) => y.amp - x.amp).slice(0, 3);
    const total = live.reduce((acc, slot) => acc + slot.amp, 0) || 1;
    let n = 0;
    const putMode = (mode, amp, sym) => {
      const b = 16 + n * 4;
      M[b] = mode[0]; M[b + 1] = mode[1]; M[b + 2] = amp; M[b + 3] = sym;
      n++;
    };
    for (const slot of live) putMode(slot.mode, slot.amp / total * 1.3, slot.sym);
    const liveCount = n;
    for (const slot of pl.slots) if (slot.oldAmp >= 0.01) putMode(slot.oldMode, slot.oldAmp / total * 1.3, slot.oldSym);
    M[0] = n;
    M[1] = Math.min(dt, 0.05);
    M[2] = pl.agitation;
    M[3] = pl.kick;
    M[4] = pl.diffusion;
    M[5] = this.time;
    // The density map's expected mean, for a look that does not depend on
    // the preset: each grain adds the integral of its soft dot.
    const count = PRESETS[this.quality].grains;
    M[6] = count * (Math.PI * 1.6 * 1.6 / 2) / (384 * 384);
    M[7] = Math.sqrt(220000 / count);
    M[8] = pl.hop;
    M[9] = pl.bassSlow;
    M[10] = liveCount;
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
    if (a.mode === 'stream' && a.streamSilent && !this.streamWarned) {
      this.streamWarned = true;
      this.#toast("this stream plays but cannot be analysed in the browser - use 'capture a tab' instead");
    }
    if (a.seekable && a.duration > 0) {
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
function readText(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

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

/** The integer hash of flight.wgsl, bit for bit, for what the CPU must
 *  agree with the shader about. */
function pcg(v) {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Where roll station k really sits, in stations off its index: the same
 *  hash and shift as `rollAt` in current.wgsl, without its slow drift. */
function rollJitter(k) {
  const ki = ((k + 120 * 4) % 120 + 120) % 120;
  const h = pcg((Math.imul(ki, 747796405) + 19) >>> 0) / 4294967296;
  return (h - 0.5) * 0.66;
}

/** Eases toward a target, never moving more than `maxStep` in one call. */
function approach(current, target, k, maxStep) {
  return current + clamp((target - current) * k, -maxStep, maxStep);
}

function smoothstep01(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A critically damped second-order response toward `target` with the given
 * natural period, integrated semi-implicitly. It eases in and out; a
 * rate-limited first-order follower moves in straight segments.
 */
function spring(state, key, target, period, dt) {
  const w = (2 * Math.PI) / period;
  const x = state[key];
  const vel = state[key + 'Vel'] ?? 0;
  const next = vel + (w * w * (target - x) - 2 * w * vel) * dt;
  state[key + 'Vel'] = next;
  state[key] = x + next * dt;
}

/** Reflects a value back into [0, span] instead of clipping at the ends. */
function foldRange(v, span) {
  const period = span * 2;
  const m = ((v % period) + period) % period;
  return m <= span ? m : period - m;
}

function mix(a, b, t) { return a + (b - a) * t; }

// The plate's modes, low to high: pairs (m, n), m < n, ordered by
// m^2 + n^2, so a low peak rings a broad figure and a high one a fine
// mesh - thirty-six of them, two semitones apart across the range.
const PLATE_MODES = (() => {
  const pairs = [];
  for (let m = 1; m <= 9; m++) for (let n = m + 1; n <= 9; n++) pairs.push([m, n]);
  return pairs.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
})();

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
