// Shared declarations prepended to every shader module.

struct Uniforms {
  resolution     : vec2f,
  invResolution  : vec2f,
  time           : f32,
  dt             : f32,
  aspect         : f32,
  particleCount  : f32,
  bass           : f32,
  lowMid         : f32,
  mid            : f32,
  high           : f32,
  level          : f32,
  beat           : f32,
  beatAge        : f32,
  flux           : f32,
  musicalMode    : f32,
  tempoDrive     : f32,
  camZoom        : f32,
  camAngle       : f32,
  camOffset      : vec2f,
  pointer        : vec2f,
  seedTime       : f32,
  exposure       : f32,
  bloomStrength  : f32,
  grain          : f32,
  speedScale     : f32,
  sizeScale      : f32,
  frame          : f32,
  warmth         : f32,
  density        : f32,   // alpha normalisation across particle-count presets
  spriteScale    : f32,   // footprint normalisation across particle presets
  mood           : f32,   // continuous palette bank position, 0..4
  flowMode       : f32,   // continuous flow-bank position, 0..3
  pointerDown    : f32,
  pointerStrength: f32,
  burstAge       : f32,
  burstStrength  : f32,
  pointerVelocity: vec2f,
  burstPos       : vec2f,
  trail0         : vec4f,
  trail1         : vec4f,
  trail2         : vec4f,
  trail3         : vec4f,
  trail4         : vec4f,
  trail5         : vec4f,
  interactionGlow: f32,
  phasePulse     : f32,
  onset          : f32,
  musicDensity   : f32,
  lull           : f32,
  breath         : f32,
  entry          : f32,
  composeSplit   : f32,
  voicePresence  : f32,
  attack         : f32,
  percussiveness : f32,
  style          : f32,   // 0 nebula 1 ink 2 constellation 3 ribbon 4 etching
  bandAttack0    : vec4f,
  bandAttack1    : vec2f,
  composeCentre  : vec2f,
  bandSustain0   : vec4f,
  bandSustain1   : vec2f,
  composeShape   : vec2f,   // x elongation, y its axis
  mode           : f32,     // 0 particle, 1 voyage, 2 current, 3 plate
  voyageZ        : f32,     // distance travelled, accumulated on the CPU
  voyageZoom     : f32,     // the user's wheel zoom alone; the flight's optics are otherwise fixed
  _tail          : f32,
  voyageA        : vec4f,   // x speed, y yaw, z pitch, w roll (gaze offsets)
  voyageB        : vec4f,   // x focus distance, y aperture, z sky count, w light count
  voyageC        : vec4f,   // x yaw rate, y pitch rate, z roll rate (rad/s), w chorus 0..1
  // The sculpture (mode 2): the music's hold on the form. Its camera is
  // the flight's.
  sculptA        : vec4f,   // x bass 0..1, y mid 0..1, z lull 0..1, w phrase energy 0..1 (all normalised)
  sculptB        : vec4f,   // x flow phase, y evolution clock (s), z strands per sheet, w sheet count
  sculptC        : vec4f,   // x pulse 1 position (path units), y its amplitude, z pulse 2 position, w its amplitude
  sculptD        : vec4f,   // x entry pulse position, y its amplitude, z echo gain, w veil gain
  sculptE        : vec4f,   // x intensity, y warm emphasis 0..1, z pulse 3 position, w its amplitude
  sculptF        : vec4f,   // x shimmer 0..1 (the highs), y first roll station in view, z w its closure and the next's
  sculptG        : vec4f,   // closures of the four stations after those, 0..1
};

struct Particle {
  pos   : vec2f,
  vel   : vec2f,
  home  : vec2f,
  seed  : f32,
  life  : f32,
  depth : f32,
  band  : f32,
};

const TAU : f32 = 6.28318530718;
const BINS : f32 = 128.0;

// The renderer's spectrum is logarithmic from 28 Hz to 16 kHz. These are the
// analysis band's 120/320/800/2000/5000 Hz edges in that same 0..1 space.
fn audioBandIndex(spectrumBand : f32) -> u32 {
  if (spectrumBand < 0.2292463) { return 0u; }
  if (spectrumBand < 0.3837528) { return 1u; }
  if (spectrumBand < 0.5280929) { return 2u; }
  if (spectrumBand < 0.6724329) { return 3u; }
  if (spectrumBand < 0.8167730) { return 4u; }
  return 5u;
}

// x size, y streak length, z lifetime decay, w response to the flow field.
// The low-mid band is deliberately the longest-lived silk population: piano
// motion remains visible between attacks instead of blinking with level.
fn bandForm(index : u32) -> vec4f {
  switch index {
    case 0u: { return vec4f(1.32, 0.55, 0.66, 0.46); }
    case 1u: { return vec4f(1.15, 0.78, 0.58, 0.63); }
    case 2u: { return vec4f(0.95, 1.34, 0.40, 0.84); }
    case 3u: { return vec4f(0.82, 1.18, 0.76, 1.08); }
    case 4u: { return vec4f(0.65, 0.74, 1.28, 1.29); }
    default: { return vec4f(0.50, 0.42, 1.68, 1.48); }
  }
}

fn bandSignal(index : u32, lower : vec4f, upper : vec2f) -> f32 {
  if (index < 4u) { return lower[index]; }
  return upper[index - 4u];
}

// -- hashing ---------------------------------------------------------------

fn hash11(p : f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  x = x * (x + x);
  return fract(x);
}

fn hash22(p : vec2f) -> vec2f {
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q = q + vec3f(dot(q, q.yzx + 33.33));
  return fract((q.xx + q.yz) * q.zy);
}

fn hash31(p : f32) -> vec3f {
  var q = fract(vec3f(p) * vec3f(0.1031, 0.1030, 0.0973));
  q = q + vec3f(dot(q, q.yzx + 33.33));
  return fract((q.xxy + q.yzz) * q.zyx);
}

// -- simplex noise (Ashima, ported) ----------------------------------------

fn mod289v3(x : vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x : vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x : vec4f) -> vec4f { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt4(r : vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }

fn snoise3(v : vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4f(0.0, 0.5, 1.0, 2.0);

  var i  = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);

  let g  = step(x0.yzx, x0.xyz);
  let l  = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);

  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;

  i = mod289v3(i);
  let p = permute4(permute4(permute4(
      i.z + vec4f(0.0, i1.z, i2.z, 1.0)) +
      i.y + vec4f(0.0, i1.y, i2.y, 1.0)) +
      i.x + vec4f(0.0, i1.x, i2.x, 1.0));

  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;

  let j  = p - 49.0 * floor(p * ns.z * ns.z);
  let xf = floor(j * ns.z);
  let yf = floor(j - 7.0 * xf);

  let x = xf * ns.x + ns.yyyy;
  let y = yf * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);

  let b0 = vec4f(x.x, x.y, y.x, y.y);
  let b1 = vec4f(x.z, x.w, y.z, y.w);

  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));

  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;

  var p0 = vec3f(a0.x, a0.y, h.x);
  var p1 = vec3f(a0.z, a0.w, h.y);
  var p2 = vec3f(a1.x, a1.y, h.z);
  var p3 = vec3f(a1.z, a1.w, h.w);

  let norm = taylorInvSqrt4(vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;

  var m = max(0.6 - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

fn fbm3(p : vec3f, octaves : i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + snoise3(q) * amp;
    q = q * 2.02 + vec3f(3.1, -1.7, 5.3);
    amp = amp * 0.5;
  }
  return sum;
}

// Scalar potential whose 2D curl drives the particle flow.
fn potential(p : vec3f) -> f32 {
  return snoise3(p) * 0.62 + snoise3(p * 2.07 + vec3f(11.3, 5.7, 2.1)) * 0.31;
}

fn curl2(p : vec2f, t : f32, scale : f32) -> vec2f {
  let e = 0.04;
  let q  = vec3f(p * scale, t);
  let n0 = potential(q);
  let nx = potential(q + vec3f(e, 0.0, 0.0));
  let ny = potential(q + vec3f(0.0, e, 0.0));
  let dx = (nx - n0) / e;
  let dy = (ny - n0) / e;
  return vec2f(dy, -dx);
}

// -- colour ----------------------------------------------------------------

fn ramp6(t : f32, c0 : vec3f, c1 : vec3f, c2 : vec3f,
         c3 : vec3f, c4 : vec3f, c5 : vec3f) -> vec3f {
  let s = clamp(t, 0.0, 1.0) * 5.0;
  var c = c0;
  c = mix(c, c1, smoothstep(0.0, 1.0, s));
  c = mix(c, c2, smoothstep(1.0, 2.0, s));
  c = mix(c, c3, smoothstep(2.0, 3.0, s));
  c = mix(c, c4, smoothstep(3.0, 4.0, s));
  c = mix(c, c5, smoothstep(4.0, 5.0, s));
  return c;
}

// Five restrained cinematic banks. Values are intentionally sub-white: the
// additive particle pass gets its sparkle from contrast, not clipping.
fn paletteOcean(t : f32) -> vec3f {
  return ramp6(t,
    vec3f(0.008, 0.018, 0.055), vec3f(0.020, 0.100, 0.240),
    vec3f(0.030, 0.330, 0.470), vec3f(0.180, 0.680, 0.690),
    vec3f(0.700, 0.870, 0.800), vec3f(0.950, 0.610, 0.310));
}

fn paletteEmber(t : f32) -> vec3f {
  return ramp6(t,
    vec3f(0.035, 0.009, 0.012), vec3f(0.180, 0.025, 0.018),
    vec3f(0.500, 0.095, 0.025), vec3f(0.900, 0.310, 0.055),
    vec3f(0.980, 0.680, 0.210), vec3f(0.950, 0.880, 0.620));
}

fn paletteAurora(t : f32) -> vec3f {
  return ramp6(t,
    vec3f(0.018, 0.008, 0.065), vec3f(0.110, 0.025, 0.260),
    vec3f(0.390, 0.060, 0.540), vec3f(0.760, 0.120, 0.560),
    vec3f(0.350, 0.550, 0.820), vec3f(0.760, 0.880, 0.900));
}

fn paletteSilver(t : f32) -> vec3f {
  return ramp6(t,
    vec3f(0.012, 0.016, 0.024), vec3f(0.055, 0.065, 0.082),
    vec3f(0.160, 0.190, 0.220), vec3f(0.390, 0.430, 0.470),
    vec3f(0.680, 0.710, 0.730), vec3f(0.940, 0.920, 0.860));
}

fn paletteNeon(t : f32) -> vec3f {
  return ramp6(t,
    vec3f(0.005, 0.025, 0.048), vec3f(0.000, 0.180, 0.260),
    vec3f(0.000, 0.560, 0.540), vec3f(0.180, 0.760, 0.570),
    vec3f(0.520, 0.420, 0.920), vec3f(0.920, 0.300, 0.650));
}

fn palette(t : f32, mood : f32) -> vec3f {
  let m = clamp(mood, 0.0, 4.0);
  let f = smoothstep(0.08, 0.92, fract(m));
  if (m < 1.0) { return mix(paletteOcean(t), paletteEmber(t), f); }
  if (m < 2.0) { return mix(paletteEmber(t), paletteAurora(t), f); }
  if (m < 3.0) { return mix(paletteAurora(t), paletteSilver(t), f); }
  if (m < 4.0) { return mix(paletteSilver(t), paletteNeon(t), f); }
  return paletteNeon(t);
}

/**
 * Visual styles. These change treatment, not signal: mood still chooses the
 * palette, flowMode still chooses the motion, the breath still breathes. A
 * style decides how a grain is drawn, not what the music is doing.
 *
 * `sharp` raises the falloff exponent, which shrinks the drawn area, so `alpha`
 * has to rise alongside it. Integrated ink is roughly
 *
 *     E = radius * (streak + radius) * alpha / (2 * sharp)
 *
 * and the first pass at these numbers put ink at E=0.49 and constellation at
 * E=0.17 against nebula's 1.0 - which rendered as a near-black screen and a
 * scattering of almost nothing. Keep an eye on E when editing.
 *
 * `keep` culls part of the population outright. Some looks cannot be reached by
 * dimming: a soft wide sprite spread across the whole population covers the
 * frame no matter how faint each one is, and the result is uniform fog rather
 * than distinct discs. Bokeh needs FEWER grains, not dimmer ones.
 */
struct StyleParams {
  radius   : f32,
  streak   : f32,
  alpha    : f32,
  sharp    : f32,
  bloom    : f32,
  sat      : f32,
  contrast : f32,
  keep     : f32,   // fraction of the population drawn at all
};

fn styleParams(i : i32) -> StyleParams {
  if (i == 1) {
    // Ink: sparse, hard-edged, nearly monochrome, almost no bloom.
    return StyleParams(1.00, 0.72, 6.20, 2.10, 0.34, 0.26, 1.42, 1.00);
  }
  if (i == 2) {
    // Constellation: tight bright points rather than filaments. Bloom is pulled
    // back because concentrating this much alpha into small cores would
    // otherwise push clustered points deep into the ACES shoulder.
    return StyleParams(0.92, 0.16, 8.20, 2.60, 0.62, 0.88, 1.16, 1.00);
  }
  if (i == 3) {
    // Ribbon: long calligraphic strands, few and continuous.
    return StyleParams(0.74, 3.40, 1.55, 1.55, 0.86, 1.04, 1.02, 0.55);
  }
  if (i == 4) {
    // Etching: thin hard scratches, like dry-point engraving.
    return StyleParams(0.34, 1.20, 7.40, 4.20, 0.10, 0.20, 1.30, 0.80);
  }
  // Nebula: the original. Soft silk and generous bloom.
  return StyleParams(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
}

/** Blended so switching styles is a transition rather than a cut. */
fn styleAt(v : f32) -> StyleParams {
  let c = clamp(v, 0.0, 4.0);
  let i = i32(floor(c));
  let f = fract(c);
  let a = styleParams(i);
  let b = styleParams(min(i + 1, 4));
  return StyleParams(
    mix(a.radius, b.radius, f),
    mix(a.streak, b.streak, f),
    mix(a.alpha, b.alpha, f),
    mix(a.sharp, b.sharp, f),
    mix(a.bloom, b.bloom, f),
    mix(a.sat, b.sat, f),
    mix(a.contrast, b.contrast, f),
    mix(a.keep, b.keep, f));
}

fn aces(x : vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linearToSrgb(c : vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn luma(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Fullscreen triangle shared by every post pass.
struct FullOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vsFull(@builtin(vertex_index) vi : u32) -> FullOut {
  var verts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let v = verts[vi];
  var o : FullOut;
  o.pos = vec4f(v, 0.0, 1.0);
  o.uv = vec2f(v.x * 0.5 + 0.5, 0.5 - v.y * 0.5);
  return o;
}
