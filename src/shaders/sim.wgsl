// Particle integration: curl-noise flow field, musical forcing, interaction.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read_write> P : array<Particle>;
@group(0) @binding(2) var<storage, read> spectrum : array<f32>;
@group(0) @binding(3) var flowAtlas : texture_2d<f32>;
@group(0) @binding(4) var flowSampler : sampler;

fn sampledFlow(pos : vec2f, depth : f32) -> vec2f {
  let uv = clamp(vec2f(pos.x / (U.aspect * 3.1) + 0.5, 0.5 - pos.y / 3.1),
                 vec2f(0.002), vec2f(0.998));
  let f = textureSampleLevel(flowAtlas, flowSampler, uv, 0.0);
  return mix(f.xy, f.zw, smoothstep(0.12, 0.88, depth));
}

// xy = world position, z = CPU-faded weight, w = polarity.
fn trailForce(pos : vec2f, node : vec4f) -> vec2f {
  if (node.z < 0.001) { return vec2f(0.0); }
  let d = node.xy - pos;
  let dl = length(d);
  return d / (dl + 0.025) * node.z * node.w * (0.92 / (1.0 + dl * dl * 24.0));
}

fn spawn(i : u32, salt : f32) -> Particle {
  let a = hash31(f32(i) * 0.6180339 + salt * 17.13);
  let b = hash31(f32(i) * 1.3170000 + salt * 3.71 + 91.7);

  // Screen-shaped disc, denser toward the middle.
  let ang = a.x * TAU;
  let rad = 0.015 + pow(a.y, 0.82) * 0.78;

  var p : Particle;
  p.pos   = vec2f(cos(ang) * rad * U.aspect, sin(ang) * rad);
  p.vel   = vec2f(cos(ang + 1.5707963), sin(ang + 1.5707963)) * (0.05 + a.z * 0.1);
  p.seed  = b.x;
  p.life  = 1.05 + b.y * 0.55;
  p.depth = b.z;
  p.band  = pow(hash11(f32(i) * 2.399 + salt), 1.25);
  // home was formerly an unused copy of pos. Cache the perceptual band here so
  // the hot simulation and draw paths do not repeat five threshold tests.
  p.home  = vec2f(f32(audioBandIndex(p.band)), 0.0);
  return p;
}

@compute @workgroup_size(64)
fn initMain(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= u32(U.particleCount)) { return; }
  var p = spawn(i, U.seedTime);
  // Stagger lifetimes so respawns never pulse in lockstep.
  p.life = 0.08 + hash11(f32(i) * 0.911 + U.seedTime) * 1.52;
  P[i] = p;
}

@compute @workgroup_size(64)
fn simMain(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= u32(U.particleCount)) { return; }

  var p = P[i];
  let dt = min(U.dt, 1.0 / 30.0);

  let bi  = u32(clamp(p.band, 0.0, 0.9999) * BINS);
  let amp = spectrum[bi];
  let instrumentBand = u32(clamp(p.home.x, 0.0, 5.0));
  let form = bandForm(instrumentBand);
  let bandAttack = bandSignal(instrumentBand, U.bandAttack0, U.bandAttack1);
  let bandSustain = bandSignal(instrumentBand, U.bandSustain0, U.bandSustain1);
  let strike = clamp(bandAttack * (0.66 + U.attack * 0.34)
                     * mix(0.70, 1.24, U.percussiveness), 0.0, 1.0);
  let held = clamp(bandSustain * mix(1.10, 0.82, U.percussiveness), 0.0, 1.0);

  // Radial terms live in screen-normalised space so the cloud stays framed.
  let nrm  = vec2f(p.pos.x / U.aspect, p.pos.y);
  let rl   = max(length(nrm), 1e-4);
  let ndir = nrm / rl;
  let worldDir = vec2f(ndir.x * U.aspect, ndir.y);
  let dir  = worldDir / max(length(worldDir), 1e-4);
  let tang = vec2f(-dir.y, dir.x);

  // Four motion languages, all built on the same spatially coherent curl
  // backbone. Analytic terms depend on position, never per-particle seed, so
  // neighbours share an axis and gather into hair-like filaments. The uniform
  // branch evaluates only the two languages currently being cross-faded.
  let flow = sampledFlow(p.pos, p.depth);
  let ang = atan2(nrm.y, nrm.x);
  let curlMode = flow * 0.68 + tang * (0.20 + U.mid * 0.48) * smoothstep(0.04, 1.0, rl);
  let coreOpen = smoothstep(0.035, 0.30, rl);
  let fm = clamp(U.flowMode, 0.0, 3.0);
  let mi = u32(floor(fm));
  let mj = min(mi + 1u, 3u);
  let mf = smoothstep(0.10, 0.90, fract(fm));
  var modeA = curlMode;
  var modeB = curlMode;

  if (mi == 0u) {
    // Radial silk: alternating coherent in/out spokes braided by curl. Radial
    // force fades at the core so it cannot excavate a hole.
    let rayWave = sin(ang * 7.0 + rl * 9.0 - U.time * 0.28 + flow.x * 0.20);
    modeB = flow * 0.56
            + dir * rayWave * coreOpen * (0.27 + amp * 0.30)
            + tang * flow.y * 0.15;
  } else if (mi == 1u) {
    let rayWave = sin(ang * 7.0 + rl * 9.0 - U.time * 0.28 + flow.x * 0.20);
    modeA = flow * 0.56
            + dir * rayWave * coreOpen * (0.27 + amp * 0.30)
            + tang * flow.y * 0.15;

    // Vortex braids: broad counter-rotating ribbons rather than independent
    // particle orbits. Reusing the radial wave lets strands cross the centre.
    let braidWave = sin(ang * 3.0 + rl * 14.0 - U.time * 0.24 + flow.y * 0.18);
    modeB = flow * 0.52
            + tang * braidWave * coreOpen * (0.30 + U.mid * 0.34)
            + dir * rayWave * 0.16;
  } else if (mi == 2u) {
    let braidWave = sin(ang * 3.0 + rl * 14.0 - U.time * 0.24 + flow.y * 0.18);
    modeA = flow * 0.52
            + tang * braidWave * coreOpen * (0.30 + U.mid * 0.34)
            + dir * flow.x * 0.16;

    // Laminar silk: alternating sheets with a shared curved tangent. Curl
    // feathers the edges instead of letting the mode collapse into flat fog.
    let sheetWave = sin(p.pos.y * 5.2 + p.pos.x * 0.85 - U.time * 0.18);
    let sheetAxis = normalize(vec2f(1.0, sheetWave * 0.22 + flow.y * 0.10));
    modeB = flow * 0.48
            + sheetAxis * sheetWave * (0.34 + amp * 0.34)
            - vec2f(0.0, nrm.y) * 0.18;
  } else {
    let sheetWave = sin(p.pos.y * 5.2 + p.pos.x * 0.85 - U.time * 0.18);
    let sheetAxis = normalize(vec2f(1.0, sheetWave * 0.22 + flow.y * 0.10));
    modeA = flow * 0.48
            + sheetAxis * sheetWave * (0.34 + amp * 0.34)
            - vec2f(0.0, nrm.y) * 0.18;
    modeB = modeA;
  }

  var acc = mix(modeA, modeB, select(mf, 0.0, mi == mj))
            * form.w * (1.0 + held * 0.22)
            * (0.52 + amp * 1.12 + U.level * 0.38) * U.speedScale;

  // Audio transients carve visible expanding rings through every mode.
  let pulse = U.beat * exp(-U.beatAge * 3.4);
  let audioRing = exp(-pow((rl - U.beatAge * 1.18) * 8.0, 2.0));
  acc += dir * pulse * coreOpen * (1.25 + amp * 1.9 + audioRing * 2.8);
  acc += dir * U.flux * audioRing * coreOpen * 1.4;
  // Linear centre hold counters centrifugal evacuation; quadratic/edge terms
  // retain the soft frame without compressing everything into a ring.
  acc -= p.pos * 0.20;
  acc -= dir * (0.22 * rl + 0.95 * rl * rl + 4.5 * smoothstep(0.60, 1.12, rl));

  // The breath is a true change of state, not a camera trick. Lull rises
  // slowly, so flow and confinement ease toward stillness without snapping;
  // a note or instrument entry wakes the field promptly on the return.
  let wake = clamp(U.entry * 0.90 + U.onset * 0.45, 0.0, 1.0);
  let quiet = clamp(U.lull * (0.88 + U.breath * 0.12) * (1.0 - wake * 0.85),
                    0.0, 1.0);
  let major = max(U.musicalMode, 0.0);
  let minor = max(-U.musicalMode, 0.0);
  let motionGain = mix(1.0, 0.10, quiet)
                   * (1.0 + U.musicDensity * 0.12 + U.tempoDrive * 0.08
                      + U.phasePulse * 0.025 + major * 0.05 - minor * 0.04);
  acc *= motionGain;

  // Note onsets articulate the existing coherent field rather than exploding
  // radially. An entry is broader and warmer: a short ignition that gathers
  // neighbouring strands into motion together.
  let noteEnergy = U.onset * (0.30 + amp * 0.52);
  acc += (flow * 0.72 + tang * flow.x * 0.10) * noteEnergy;
  acc += (flow * 0.88 + tang * (0.07 + amp * 0.10)) * U.entry
         * (0.62 + U.musicDensity * 0.26);

  // Only a stable fraction of each struck band sparks. The kick follows the
  // shared flow axis, so piano attacks articulate the silk instead of spraying
  // independent grains in every direction.
  let strikeClass = smoothstep(0.68, 0.96, hash11(p.seed * 47.31 + 5.7));
  let struck = strike * strikeClass;
  acc += (flow * 0.82 + tang * flow.x * 0.14) * struck
         * (0.42 + form.w * 0.24);

  // A voice gathers a small, frequency-independent population into two fine
  // central ribbons. It is a physical arrival, not a light pulse. Squared and
  // confidence-gated on the CPU, this is exactly zero for mono or microphone
  // input and remains weak for the track's occasional centred strings.
  let voiceGain = clamp(U.voicePresence * 3.2, 0.0, 1.0) * (1.0 - quiet * 0.92);
  if (voiceGain > 0.001 && p.seed < 0.115) {
    let voiceU = p.seed / 0.115;
    let vy = (voiceU * 2.0 - 1.0) * 0.76;
    let side = select(-1.0, 1.0, hash11(p.seed * 173.7 + 2.1) > 0.5);
    let curve = (vy - vy * vy * vy) * 0.22 * U.aspect;
    let sway = sin(U.time * 0.22 + p.depth * TAU) * 0.026 * U.aspect;
    let ribbon = vec2f(curve + side * (0.018 + p.depth * 0.026) + sway, vy);
    acc = mix(acc, flow * (0.24 + held * 0.10), voiceGain * 0.34);
    acc += (ribbon - p.pos) * voiceGain * 3.8;
  }

  // Resting pointer is subtle; a held pointer becomes a tactile attract/repel
  // tool and inherits drag velocity like a brush moving through smoke.
  let dm  = U.pointer - p.pos;
  let dml = length(dm);
  acc += (dm / (dml + 0.012)) * (0.14 / (1.0 + dml * dml * 12.0));
  let pointerFalloff = 1.0 / (1.0 + dml * dml * 18.0);
  acc += (dm / (dml + 0.018)) * U.pointerStrength * U.pointerDown
         * pointerFalloff * 2.5;
  acc += U.pointerVelocity * U.pointerDown * pointerFalloff * 1.65;

  // Click shockwave, centred at the actual interaction rather than the frame.
  let bd = p.pos - U.burstPos;
  let bdl = length(bd);
  let bdir = bd / (bdl + 0.012);
  let burstRing = exp(-pow((bdl - U.burstAge * 1.28) * 9.0, 2.0));
  let burstEnv = U.burstStrength * exp(-U.burstAge * 2.1);
  acc += bdir * burstEnv * (burstRing * 5.2 + exp(-bdl * bdl * 14.0) * 1.6);

  // Dragging paints a persistent, slowly evaporating attractor/repulsor path.
  acc += trailForce(p.pos, U.trail0) + trailForce(p.pos, U.trail1)
       + trailForce(p.pos, U.trail2) + trailForce(p.pos, U.trail3)
       + trailForce(p.pos, U.trail4) + trailForce(p.pos, U.trail5);

  // Low bands retain momentum; high bands answer and settle quickly. Sustained
  // material carries a little more of its previous tangent between frames.
  let bandProgress = f32(instrumentBand) * 0.2;
  let baseDamping = min(0.984, mix(0.978, 0.936, bandProgress) + held * 0.005);
  let damping = mix(baseDamping, 0.890, quiet);

  p.vel = (p.vel + acc * dt) * pow(damping, dt * 60.0);

  let sp = length(p.vel);
  if (sp > 1.45) { p.vel = p.vel * (1.45 / sp); }

  p.pos += p.vel * dt;
  p.life -= dt * (0.085 + 0.06 * U.level) * form.z
            * mix(1.0, 0.66, held) * (1.0 + struck * 0.16)
            * mix(1.0, 0.38, U.lull);

  let bound = 1.35 * max(1.0, U.aspect);
  if (p.life <= 0.0 || length(p.pos) > bound) {
    p = spawn(i, U.seedTime + floor(U.time * 0.41) * 1.7);
  }

  P[i] = p;
}
