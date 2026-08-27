/**
 * WebGPU renderer.
 *
 * Frame graph:
 *   compute  flowMain (60 Hz)  -> compact dual-depth curl atlas
 *   compute  simMain           -> particle storage buffer
 *   render   background        -> quarter-resolution HDR backdrop
 *   render   linear blit       -> HDR scene (rgba16float)
 *   render   particles         -> HDR scene, additive
 *   render   bloom downsample  -> mip chain (prefilter on mip 0)
 *   render   bloom upsample    -> mip chain, additive tent
 *   render   composite         -> swap chain
 */

const SHADERS = [
  'common', 'flow', 'sim', 'particles', 'background', 'blit', 'bloom', 'composite', 'voyage',
];

const SPECTRUM_BINS = 128;
const PARTICLE_STRIDE = 40; // bytes: pos, vel, home, seed, life, depth, band
const UNIFORM_FLOATS = 100;

const U = {
  resX: 0, resY: 1, invX: 2, invY: 3,
  time: 4, dt: 5, aspect: 6, count: 7,
  bass: 8, lowMid: 9, mid: 10, high: 11,
  level: 12, beat: 13, beatAge: 14, flux: 15,
  musicalMode: 16, tempoDrive: 17, camZoom: 18, camAngle: 19,
  camX: 20, camY: 21, ptrX: 22, ptrY: 23,
  seedTime: 24, exposure: 25, bloom: 26, grain: 27,
  speed: 28, size: 29, frame: 30, warmth: 31,
  density: 32, spriteScale: 33, mood: 34, flowMode: 35,
  pointerDown: 36, pointerStrength: 37, burstAge: 38, burstStrength: 39,
  pointerVelX: 40, pointerVelY: 41, burstX: 42, burstY: 43,
  trail0: 44, trail1: 48, trail2: 52, trail3: 56, trail4: 60, trail5: 64,
  interactionGlow: 68, phasePulse: 69, onset: 70, musicDensity: 71,
  lull: 72, breath: 73, entry: 74, composeSplit: 75,
  voicePresence: 76, attack: 77, percussiveness: 78, style: 79,
  bandAttack: 80, bandSustain: 88,
  composeCentreX: 86, composeCentreY: 87,
  composeStretch: 94, composeAngle: 95,
  mode: 96, voyageZ: 97, voyageTurn: 98,
};

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.uniformData = new Float32Array(UNIFORM_FLOATS);
    this.spectrumData = new Float32Array(SPECTRUM_BINS);
    this.particleCount = 600000;
    this.resolutionScale = 1;
    this.frameIndex = 0;
    this.width = 0;
    this.height = 0;
    this.mips = [];
    this.interaction = {
      hasPointer: false,
      down: 0,
      strength: 1,
      x: 0,
      y: 0,
      velX: 0,
      velY: 0,
      lastX: 0,
      lastY: 0,
      lastMoveAt: performance.now(),
      burstX: 0,
      burstY: 0,
      burstAge: 99,
      burstStrength: 0,
      zoom: 1,
      zoomTarget: 1,
      mode: null,
      glow: 0,
      lastTrailAt: 0,
      trailCursor: 0,
      trails: Array.from({ length: 6 }, () => ({ x: 0, y: 0, age: 99, polarity: 1 })),
    };
    this.#wireInteraction();
  }

  #pointerWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    const aspect = Math.max(0.4, r.width / Math.max(r.height, 1));
    return {
      x: ((e.clientX - r.left) / Math.max(r.width, 1) - 0.5) * 2 * aspect,
      y: (0.5 - (e.clientY - r.top) / Math.max(r.height, 1)) * 2,
    };
  }

  #wireInteraction() {
    const it = this.interaction;
    const move = (e, paint = false) => {
      const p = this.#pointerWorld(e);
      const now = performance.now();
      const dt = Math.max(1 / 240, Math.min(0.08, (now - it.lastMoveAt) / 1000));
      if (it.hasPointer) {
        const vx = (p.x - it.lastX) / dt;
        const vy = (p.y - it.lastY) / dt;
        it.velX = Math.max(-4, Math.min(4, it.velX * 0.35 + vx * 0.65));
        it.velY = Math.max(-4, Math.min(4, it.velY * 0.35 + vy * 0.65));
      }
      it.x = p.x;
      it.y = p.y;
      it.lastX = p.x;
      it.lastY = p.y;
      it.lastMoveAt = now;
      it.hasPointer = true;

      if (paint && (it.lastTrailAt === 0 || now - it.lastTrailAt > 75)) {
        const node = it.trails[it.trailCursor];
        node.x = p.x;
        node.y = p.y;
        node.age = 0;
        node.polarity = Math.sign(it.strength) || 1;
        it.trailCursor = (it.trailCursor + 1) % it.trails.length;
        it.lastTrailAt = now;
      }
    };

    this.canvas.addEventListener('pointermove', (e) => move(e, it.down > 0));
    this.canvas.addEventListener('pointerdown', (e) => {
      // Shift-drag repels; an ordinary drag attracts and pushes with velocity.
      it.strength = e.shiftKey ? -1 : 1;
      move(e, true);
      this.canvas.setPointerCapture?.(e.pointerId);
      it.down = 1;
      it.burstX = it.x;
      it.burstY = it.y;
      it.burstAge = 0;
      it.burstStrength = e.shiftKey ? -0.8 : 1;
      it.glow = 1;
    });
    const release = () => { it.down = 0; };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyG') {
        // G steps through the flow bank; Shift+G returns to automatic travel.
        it.mode = e.shiftKey ? null : (it.mode == null ? 1 : (it.mode + 1) % 4);
        it.glow = 1;
      }
    });
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No suitable GPU adapter was found.');

    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(
          adapter.limits.maxStorageBufferBindingSize, 256 * 1024 * 1024),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 256 * 1024 * 1024),
      },
    });
    this.adapterInfo = adapter.info ?? {};

    this.device.lost.then((info) => {
      if (info.reason !== 'destroyed') console.error('WebGPU device lost:', info.message);
    });
    this.device.addEventListener?.('uncapturederror', (e) => console.error(e.error));

    this.context = this.canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
      colorSpace: 'srgb',
    });

    await this.#loadShaders();
    this.#createStaticResources();
    this.#createPipelines();
    this.resize();
    this.reseed();
  }

  async #loadShaders() {
    const sources = await Promise.all(SHADERS.map(async (name) => {
      // Revalidate every time. These are fetched, not imported, so a query
      // string on the page does not bust them - a stale shader will happily
      // pair with fresh JS and render a black screen.
      const res = await fetch(`./src/shaders/${name}.wgsl`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Failed to load shader ${name}.wgsl (${res.status})`);
      return [name, await res.text()];
    }));
    const src = Object.fromEntries(sources);
    const common = src.common;

    this.modules = {};
    const created = [];
    for (const name of SHADERS) {
      if (name === 'common') continue;
      const code = `${common}\n\n${src[name]}`;
      this.modules[name] = this.device.createShaderModule({ code, label: name });
      created.push(name);
    }

    // A shader that fails to compile leaves its pipeline invalid, and the piece
    // then renders a perfectly black frame at a perfectly healthy frame rate -
    // which looks like anything but a compile error. So this is fatal rather
    // than logged. Every module is created before any of them is inspected,
    // and each check is bounded: awaiting compilation info one module at a time
    // can stall indefinitely, which trades a black screen for a stuck boot.
    const commonLines = common.split('\n').length + 1;
    const failures = [];
    await Promise.all(created.map(async (name) => {
      const info = await Promise.race([
        this.modules[name].getCompilationInfo(),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (!info) return;
      for (const m of info.messages) {
        // Report against the file the author edits, not the concatenation with
        // common.wgsl that the device actually compiled.
        const line = m.lineNum > commonLines ? m.lineNum - commonLines : m.lineNum;
        const where = `${name}.wgsl:${line}:${m.linePos}`;
        if (m.type === 'error') failures.push(`${where} ${m.message}`);
        else console.warn(`${where} ${m.message}`);
      }
    }));
    if (failures.length) throw new Error(`shader compilation failed\n${failures.join('\n')}`);
  }

  #createStaticResources() {
    const d = this.device;

    this.uniformBuffer = d.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniforms',
    });

    this.spectrumBuffer = d.createBuffer({
      size: SPECTRUM_BINS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'spectrum',
    });

    this.sampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Two depth slices of curl packed into one compact, bilinear field.
    this.flowTexture = d.createTexture({
      size: [256, 128],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: 'curl-atlas',
    });
    this.flowView = this.flowTexture.createView();

    this.#createParticleBuffer();
  }

  #createParticleBuffer() {
    this.particleBuffer?.destroy();
    this.particleBuffer = this.device.createBuffer({
      size: this.particleCount * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE,
      label: 'particles',
    });
    if (this.simLayout) this.#createSimBindGroups();
  }

  #createSimBindGroups() {
    const d = this.device;
    this.simBindGroup = d.createBindGroup({
      layout: this.simLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer } },
        { binding: 2, resource: { buffer: this.spectrumBuffer } },
        { binding: 3, resource: this.flowView },
        { binding: 4, resource: this.sampler },
      ],
    });
    this.drawBindGroup = d.createBindGroup({
      layout: this.drawLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.particleBuffer } },
        { binding: 2, resource: { buffer: this.spectrumBuffer } },
      ],
    });
  }

  #createPipelines() {
    const d = this.device;

    // --- baked curl field -------------------------------------------------
    this.flowLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float' },
        },
      ],
    });
    this.flowPipeline = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.flowLayout] }),
      compute: { module: this.modules.flow, entryPoint: 'flowMain' },
    });
    this.flowBindGroup = d.createBindGroup({
      layout: this.flowLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.flowView },
      ],
    });

    // --- simulation -------------------------------------------------------
    this.simLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });
    const simPl = d.createPipelineLayout({ bindGroupLayouts: [this.simLayout] });
    this.simPipeline = d.createComputePipeline({
      layout: simPl,
      compute: { module: this.modules.sim, entryPoint: 'simMain' },
    });
    this.initPipeline = d.createComputePipeline({
      layout: simPl,
      compute: { module: this.modules.sim, entryPoint: 'initMain' },
    });

    // --- particle draw ----------------------------------------------------
    this.drawLayout = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const additive = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    };
    this.particlePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.drawLayout] }),
      vertex: { module: this.modules.particles, entryPoint: 'vs' },
      fragment: {
        module: this.modules.particles,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float', blend: additive }],
      },
      primitive: { topology: 'triangle-strip' },
    });

    // --- background -------------------------------------------------------
    this.bgLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bgPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgLayout] }),
      vertex: { module: this.modules.background, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.background,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.bgBindGroup = d.createBindGroup({
      layout: this.bgLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.spectrumBuffer } },
      ],
    });

    // The costly procedural background renders small, then expands once with
    // hardware linear filtering into the HDR scene.
    this.blitLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.blitPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: this.modules.blit, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.blit,
        entryPoint: 'blit',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // --- bloom ------------------------------------------------------------
    this.bloomLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const bloomPl = d.createPipelineLayout({ bindGroupLayouts: [this.bloomLayout] });
    this.downPipeline = d.createRenderPipeline({
      layout: bloomPl,
      vertex: { module: this.modules.bloom, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.bloom,
        entryPoint: 'downsample',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.upPipeline = d.createRenderPipeline({
      layout: bloomPl,
      vertex: { module: this.modules.bloom, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.bloom,
        entryPoint: 'upsample',
        targets: [{ format: 'rgba16float', blend: additive }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // --- voyage -----------------------------------------------------------
    // Writes into the same HDR scene target as the particle path, so the bloom
    // chain and the whole grade apply to it without duplication.
    this.voyagePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.bgLayout] }),
      vertex: { module: this.modules.voyage, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.voyage,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // --- composite --------------------------------------------------------
    this.compositeLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.compositePipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: this.modules.composite, entryPoint: 'vsFull' },
      fragment: {
        module: this.modules.composite,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.#createSimBindGroups();
  }

  resize() {
    // Capped at 3 so a phone renders natively; desktop Retina is 2 regardless.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr * this.resolutionScale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr * this.resolutionScale));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const d = this.device;
    this.sceneTexture?.destroy();
    this.sceneTexture = d.createTexture({
      size: [w, h],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'scene-hdr',
    });
    this.sceneView = this.sceneTexture.createView();

    this.backgroundTexture?.destroy();
    this.backgroundWidth = Math.max(2, Math.ceil(w / 4));
    this.backgroundHeight = Math.max(2, Math.ceil(h / 4));
    this.backgroundTexture = d.createTexture({
      size: [this.backgroundWidth, this.backgroundHeight],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'background-quarter',
    });
    this.backgroundView = this.backgroundTexture.createView();

    // Voyage marches at half resolution. Wisps are soft enough that the
    // resolution is not missed, and a full-res march of this step count is the
    // difference between 33 fps and comfortable.
    this.voyageTexture?.destroy();
    this.voyageTexture = d.createTexture({
      size: [Math.max(2, Math.ceil(w / 2)), Math.max(2, Math.ceil(h / 2))],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'voyage-half',
    });
    this.voyageView = this.voyageTexture.createView();
    this.voyageBlitBindGroup = d.createBindGroup({
      layout: this.blitLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.voyageView },
      ],
    });
    this.blitBindGroup = d.createBindGroup({
      layout: this.blitLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.backgroundView },
      ],
    });

    for (const m of this.mips) m.texture.destroy();
    this.mips = [];
    let mw = w;
    let mh = h;
    for (let i = 0; i < 6; i++) {
      mw = Math.floor(mw / 2);
      mh = Math.floor(mh / 2);
      if (mw < 8 || mh < 8) break;
      const texture = d.createTexture({
        size: [mw, mh],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label: `bloom-${i}`,
      });
      this.mips.push({ texture, view: texture.createView(), w: mw, h: mh });
    }

    this.#buildBloomPasses();

    const wideIndex = Math.min(4, this.mips.length - 1);
    this.compositeBindGroup = d.createBindGroup({
      layout: this.compositeLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.sceneView },
        { binding: 2, resource: this.mips[0].view },
        { binding: 3, resource: this.mips[wideIndex].view },
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  #buildBloomPasses() {
    const d = this.device;
    for (const b of this.bloomUniformBuffers ?? []) b.destroy();
    this.bloomUniformBuffers = [];
    this.downPasses = [];
    this.upPasses = [];

    const makeParams = (texelW, texelH, threshold, knee, scatter, mode) => {
      const buf = d.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const data = new Float32Array([1 / texelW, 1 / texelH, threshold, knee, scatter, mode, 0, 0]);
      d.queue.writeBuffer(buf, 0, data);
      this.bloomUniformBuffers.push(buf);
      return buf;
    };

    // Downsample: scene -> mip0 -> mip1 -> ...
    for (let i = 0; i < this.mips.length; i++) {
      const srcView = i === 0 ? this.sceneView : this.mips[i - 1].view;
      const srcW = i === 0 ? this.width : this.mips[i - 1].w;
      const srcH = i === 0 ? this.height : this.mips[i - 1].h;
      const params = makeParams(srcW, srcH, 0.62, 0.35, 1, i === 0 ? 1 : 0);
      this.downPasses.push({
        target: this.mips[i].view,
        bindGroup: d.createBindGroup({
          layout: this.bloomLayout,
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: srcView },
            { binding: 2, resource: { buffer: params } },
          ],
        }),
      });
    }

    // Upsample: mipN -> mipN-1, additively.
    for (let i = this.mips.length - 1; i > 0; i--) {
      const params = makeParams(this.mips[i].w, this.mips[i].h, 0, 0, 0.82, 0);
      this.upPasses.push({
        target: this.mips[i - 1].view,
        bindGroup: d.createBindGroup({
          layout: this.bloomLayout,
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: this.mips[i].view },
            { binding: 2, resource: { buffer: params } },
          ],
        }),
      });
    }
  }

  setParticleCount(n) {
    this.particleCount = n;
    this.#createParticleBuffer();
    this.reseed();
  }

  setResolutionScale(s) {
    this.resolutionScale = s;
    this.width = 0;
    this.resize();
  }

  reseed() {
    this.pendingInit = true;
  }

  #updateInteraction(dt) {
    const it = this.interaction;
    it.burstAge += dt;
    it.zoom += (it.zoomTarget - it.zoom) * Math.min(1, dt * 8);
    const velocityDecay = Math.exp(-dt * (it.down ? 4 : 12));
    it.velX *= velocityDecay;
    it.velY *= velocityDecay;
    for (const node of it.trails) node.age += dt;
    const glowTarget = it.down ? 1 : Math.exp(-it.burstAge * 2.6) * 0.75;
    it.glow += (glowTarget - it.glow) * Math.min(1, dt * 5);
  }

  frame(state) {
    const d = this.device;
    const u = this.uniformData;
    const aspect = this.width / this.height;
    const dt = state.dt ?? 1 / 60;
    this.#updateInteraction(dt);
    const it = this.interaction;
    const time = state.time ?? 0;

    const moodPhase = (time / 26) % 8;
    const autoMood = moodPhase <= 4 ? moodPhase : 8 - moodPhase;
    const flowPhase = (time / 18) % 6;
    const autoFlow = flowPhase <= 3 ? flowPhase : 6 - flowPhase;
    const countRatio = 620000 / this.particleCount;
    const tempo = state.tempo ?? 0;
    const tempoConfidence = Math.max(0, Math.min(1, state.tempoConfidence ?? 0));
    const tempoTrust = tempoConfidence * tempoConfidence;
    const tempoNorm = tempo > 0 ? Math.max(0, Math.min(1, (tempo - 48) / 132)) : 0;
    const beatPhase = ((state.beatPhase ?? 0) % 1 + 1) % 1;
    const phaseCarrier = Math.max(0, Math.cos(beatPhase * Math.PI * 2));
    const phasePulse = Math.pow(phaseCarrier, 8) * tempoTrust;

    const pointerX = it.hasPointer ? it.x : (state.pointerX ?? 0);
    const pointerY = it.hasPointer ? it.y : (state.pointerY ?? 0);
    const pointerDown = Math.max(state.pointerDown ?? 0, it.down);
    const externalBurstAge = state.burstAge ?? 99;
    const directBurstWins = it.burstAge < externalBurstAge + 0.04;
    const burstAge = directBurstWins ? it.burstAge : externalBurstAge;
    const burstStrength = directBurstWins ? it.burstStrength : (state.burstStrength ?? 0);
    const burstX = directBurstWins ? it.burstX : (state.burstX ?? 0);
    const burstY = directBurstWins ? it.burstY : (state.burstY ?? 0);

    u[U.resX] = this.width;
    u[U.resY] = this.height;
    u[U.invX] = 1 / this.width;
    u[U.invY] = 1 / this.height;
    u[U.time] = time;
    u[U.dt] = dt;
    u[U.aspect] = aspect;
    u[U.count] = this.particleCount;
    u[U.bass] = state.bass ?? 0;
    u[U.lowMid] = state.lowMid ?? 0;
    u[U.mid] = state.mid ?? 0;
    u[U.high] = state.high ?? 0;
    u[U.level] = state.level ?? 0;
    u[U.beat] = state.beat ?? 0;
    u[U.beatAge] = state.beatAge ?? 99;
    u[U.flux] = state.flux ?? 0;
    u[U.musicalMode] = Math.max(-1, Math.min(1, state.musicalMode ?? 0));
    u[U.tempoDrive] = tempoNorm * tempoTrust;
    u[U.camZoom] = (state.camZoom ?? 1) * (state.zoom ?? 1);
    u[U.camAngle] = state.camAngle ?? 0;
    u[U.camX] = state.camX ?? 0;
    u[U.camY] = state.camY ?? 0;
    u[U.ptrX] = pointerX;
    u[U.ptrY] = pointerY;
    u[U.seedTime] = state.seedTime ?? 0;
    u[U.exposure] = state.exposure ?? 1.1;
    u[U.bloom] = state.bloomStrength ?? 0.72;
    u[U.grain] = state.grain ?? 0.016;
    u[U.speed] = state.speedScale ?? 1;
    u[U.size] = state.sizeScale ?? 1;
    u[U.frame] = this.frameIndex % 4096;
    u[U.warmth] = state.warmth ?? 0;
    // Linear footprint N^-0.4 + alpha N^-0.2 keeps total ink constant while
    // fill grows only N^0.2 between presets.
    u[U.density] = Math.pow(countRatio, 0.2);
    u[U.spriteScale] = Math.pow(countRatio, 0.4);
    u[U.mood] = state.mood ?? autoMood;
    u[U.flowMode] = it.mode ?? state.flowMode ?? autoFlow;
    u[U.pointerDown] = pointerDown;
    u[U.pointerStrength] = state.pointerStrength ?? it.strength;
    u[U.burstAge] = burstAge;
    u[U.burstStrength] = burstStrength;
    u[U.pointerVelX] = state.pointerVelX ?? it.velX;
    u[U.pointerVelY] = state.pointerVelY ?? it.velY;
    u[U.burstX] = burstX;
    u[U.burstY] = burstY;

    let trailGlow = 0;
    for (let i = 0; i < it.trails.length; i++) {
      const node = it.trails[i];
      const weight = Math.exp(-node.age * 0.30) * 0.82;
      const offset = U.trail0 + i * 4;
      u[offset] = node.x;
      u[offset + 1] = node.y;
      u[offset + 2] = weight;
      u[offset + 3] = node.polarity;
      trailGlow = Math.max(trailGlow, weight);
    }
    u[U.style] = state.style ?? 0;
    u[U.mode] = state.mode ?? 0;
    u[U.voyageZ] = state.voyageZ ?? 0;
    u[U.voyageTurn] = state.voyageTurn ?? 0;
    u[U.composeCentreX] = state.composeCentreX ?? 0;
    u[U.composeCentreY] = state.composeCentreY ?? 0;
    u[U.composeStretch] = state.composeStretch ?? 0;
    u[U.composeAngle] = state.composeAngle ?? 0;
    u[U.composeSplit] = state.composeSplit ?? 0;
    u[U.interactionGlow] = state.interactionGlow
      ?? Math.max(it.glow, pointerDown * 0.8, trailGlow * 0.32);
    u[U.phasePulse] = phasePulse;
    u[U.onset] = clamp01(state.onset);
    u[U.musicDensity] = clamp01(state.density);
    u[U.lull] = clamp01(state.lull);
    u[U.breath] = clamp01(state.breath);
    u[U.entry] = clamp01(state.entry);

    // The analyser already gives voice a phrase-length envelope. Squaring the
    // hint separates a real entrance from occasional centred strings without
    // turning it into a binary detector; confidence makes mono/mic input an
    // exact no-op.
    const voice = clamp01(state.voice);
    u[U.voicePresence] = voice * voice * clamp01(state.voiceConfidence);
    u[U.attack] = clamp01(state.attack);
    u[U.percussiveness] = clamp01(state.percussiveness);
    const bandAttack = state.bandAttack;
    const bandSustain = state.bandSustain;
    for (let i = 0; i < 6; i++) {
      u[U.bandAttack + i] = clamp01(bandAttack?.[i]);
      u[U.bandSustain + i] = clamp01(bandSustain?.[i]);
    }

    d.queue.writeBuffer(this.uniformBuffer, 0, u);
    d.queue.writeBuffer(this.spectrumBuffer, 0, state.spectrum);

    const voyage = (state.mode ?? 0) >= 0.5;
    const encoder = d.createCommandEncoder();
    const workgroups = Math.ceil(this.particleCount / 64);

    // The field evolves very slowly; a 60 Hz atlas is indistinguishable on a
    // 120 Hz display and halves even this already compact noise pass.
    if (!voyage && (this.frameIndex & 1) === 0) {
      const pass = encoder.beginComputePass({ label: 'flow-atlas' });
      pass.setPipeline(this.flowPipeline);
      pass.setBindGroup(0, this.flowBindGroup);
      pass.dispatchWorkgroups(32, 16);
      pass.end();
    }

    if (!voyage) {
      const pass = encoder.beginComputePass({ label: 'sim' });
      pass.setBindGroup(0, this.simBindGroup);
      if (this.pendingInit) {
        pass.setPipeline(this.initPipeline);
        pass.dispatchWorkgroups(workgroups);
        this.pendingInit = false;
      }
      pass.setPipeline(this.simPipeline);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
    }

    if (voyage) {
      const pass = encoder.beginRenderPass({
        label: 'voyage-half',
        colorAttachments: [{
          view: this.voyageView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.voyagePipeline);
      pass.setBindGroup(0, this.bgBindGroup);
      pass.draw(3);
      pass.end();
    }

    if (!voyage) {
      const pass = encoder.beginRenderPass({
        label: 'background-quarter',
        colorAttachments: [{
          view: this.backgroundView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.bgPipeline);
      pass.setBindGroup(0, this.bgBindGroup);
      pass.draw(3);
      pass.end();
    }

    {
      const pass = encoder.beginRenderPass({
        label: 'scene',
        colorAttachments: [{
          view: this.sceneView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      if (voyage) {
        // Voyage replaces the backdrop and the particles both. It was marched
        // at half resolution above; this upsamples it into the HDR scene so the
        // bloom chain and grade apply to it unchanged.
        pass.setPipeline(this.blitPipeline);
        pass.setBindGroup(0, this.voyageBlitBindGroup);
        pass.draw(3);
      } else {
        pass.setPipeline(this.blitPipeline);
        pass.setBindGroup(0, this.blitBindGroup);
        pass.draw(3);

        pass.setPipeline(this.particlePipeline);
        pass.setBindGroup(0, this.drawBindGroup);
        pass.draw(4, this.particleCount);
      }
      pass.end();
    }

    for (const p of this.downPasses) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: p.target, clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        }],
      });
      pass.setPipeline(this.downPipeline);
      pass.setBindGroup(0, p.bindGroup);
      pass.draw(3);
      pass.end();
    }

    for (const p of this.upPasses) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: p.target, loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.upPipeline);
      pass.setBindGroup(0, p.bindGroup);
      pass.draw(3);
      pass.end();
    }

    {
      const pass = encoder.beginRenderPass({
        label: 'composite',
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.compositePipeline);
      pass.setBindGroup(0, this.compositeBindGroup);
      pass.draw(3);
      pass.end();
    }

    d.queue.submit([encoder.finish()]);
    this.frameIndex++;
  }
}

export { SPECTRUM_BINS };
