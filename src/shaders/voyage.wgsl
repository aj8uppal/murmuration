// Voyage: a flight through a field of lights.
//
// Not a particle simulation and not a raymarch. A sparse population of lights
// in three dimensions, each derived from nothing but its instance index and a
// hash, drawn as camera-facing bokeh sprites through a real perspective camera
// that flies along a slowly curving path. It lands in the same HDR target as
// the particle mode, so the bloom chain and the grade are shared.
//
// Lights live in path coordinates: an arc distance s along the flight and a
// lateral offset in the path's moving frame. s wraps inside a window around the
// camera, and the wrap count is folded into the hash, so a light that falls
// behind the camera reappears far ahead as a different light. The path is
// periodic in PERIOD and the CPU keeps the travelled distance inside it, which
// holds f32 precision at a fraction of a millimetre however long the flight.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;

const WINDOW : f32 = 96.0;    // how much of the path holds lights at once
const BACK   : f32 = 6.0;     // of which, how much lies behind the camera
const WRAPS  : f32 = 128.0;   // windows per period
const PERIOD : f32 = WINDOW * WRAPS;

// Every path frequency is an integer multiple of this, which is what makes the
// path periodic in PERIOD.
const K : f32 = 6.28318530718 / PERIOD;

// Vertical field of view is fixed at 52 degrees. Optics that never move are a
// large part of what makes the flight tranquil.
const PROJ : f32 = 2.0503;

// -- hashing ------------------------------------------------------------------
// Integer hashing: the float hashes in common.wgsl lose most of their bits once
// the key climbs past a few thousand, and the wrap keys here reach millions.

fn pcg(v : u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash3u(key : u32) -> vec3f {
  let a = pcg(key);
  let b = pcg(a);
  let c = pcg(b);
  return vec3f(f32(a), f32(b), f32(c)) * (1.0 / 4294967296.0);
}

// -- the path -----------------------------------------------------------------

/** A gentle meander: about nine degrees of heading and four of pitch. */
fn pathAt(s : f32) -> vec3f {
  return vec3f(
    sin(s * (41.0 * K)) * 4.2 + sin(s * (87.0 * K) + 1.3) * 1.6,
    sin(s * (32.0 * K) + 0.8) * 2.2 + sin(s * (67.0 * K) + 2.4) * 0.9,
    s);
}

fn pathTangent(s : f32) -> vec3f {
  return normalize(vec3f(
    cos(s * (41.0 * K)) * (4.2 * 41.0 * K) + cos(s * (87.0 * K) + 1.3) * (1.6 * 87.0 * K),
    cos(s * (32.0 * K) + 0.8) * (2.2 * 32.0 * K) + cos(s * (67.0 * K) + 2.4) * (0.9 * 67.0 * K),
    1.0));
}

struct Frame { t : vec3f, n : vec3f, b : vec3f };

/** Tangent, right, up. The path never pitches near vertical, so world-up is a
 *  safe reference and the frame cannot flip. */
fn frameAt(s : f32) -> Frame {
  let t = pathTangent(s);
  let n = normalize(cross(vec3f(0.0, 1.0, 0.0), t));
  return Frame(t, n, cross(t, n));
}

struct Camera {
  pos   : vec3f,
  f     : Frame,
  proj  : f32,
  yaw   : f32,
  pitch : f32,
  roll  : f32,
};

fn cameraAt(z : f32) -> Camera {
  var c : Camera;
  c.pos = pathAt(z);
  c.f = frameAt(z);
  c.proj = PROJ * U.camZoom;
  c.yaw = U.voyageA.y;
  c.pitch = U.voyageA.z;
  // Lean into the turn: bank follows the lateral acceleration the bend would
  // actually put on the camera at this speed.
  let curvature = (pathTangent(z + 1.0) - pathTangent(z - 1.0)) * 0.5;
  let lateralAccel = U.voyageA.x * U.voyageA.x * dot(curvature, c.f.n);
  c.roll = U.voyageA.w - clamp(atan(lateralAccel / 4.5), -0.07, 0.07);
  return c;
}

/** World direction -> view space, with the gaze offsets applied. */
fn dirToView(d : vec3f, c : Camera) -> vec3f {
  var v = vec3f(dot(d, c.f.n), dot(d, c.f.b), dot(d, c.f.t));
  let cy = cos(c.yaw);   let sy = sin(c.yaw);
  v = vec3f(v.x * cy - v.z * sy, v.y, v.x * sy + v.z * cy);
  let cp = cos(c.pitch); let sp = sin(c.pitch);
  v = vec3f(v.x, v.y * cp - v.z * sp, v.y * sp + v.z * cp);
  let cr = cos(c.roll);  let sr = sin(c.roll);
  return vec3f(v.x * cr - v.y * sr, v.x * sr + v.y * cr, v.z);
}

/** View space -> world direction (the inverse of dirToView). */
fn viewToDir(v0 : vec3f, c : Camera) -> vec3f {
  var v = v0;
  let cr = cos(c.roll);  let sr = sin(c.roll);
  v = vec3f(v.x * cr + v.y * sr, -v.x * sr + v.y * cr, v.z);
  let cp = cos(c.pitch); let sp = sin(c.pitch);
  v = vec3f(v.x, v.y * cp + v.z * sp, -v.y * sp + v.z * cp);
  let cy = cos(c.yaw);   let sy = sin(c.yaw);
  v = vec3f(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
  return c.f.n * v.x + c.f.b * v.y + c.f.t * v.z;
}

/** Perspective projection into "unit" space: y in -1..1, x in -aspect..aspect. */
fn project(v : vec3f, proj : f32) -> vec2f {
  return v.xy * proj / v.z;
}

// -- palette ------------------------------------------------------------------

/** Three anchors, not the whole ramp: a dominant hue, a supporting one, and a
 *  rare accent. Spectrum decides brightness, never hue - 128 bands of colour
 *  would be confetti. */
fn lightColour(pick : f32, jitter : f32) -> vec3f {
  var anchor = 0.52;
  if (pick > 0.72) { anchor = 0.72; }
  if (pick > 0.95) { anchor = 0.94; }
  let t = anchor + (jitter - 0.5) * 0.036 + U.musicalMode * 0.015 + U.warmth * 0.03;
  var c = palette(clamp(t, 0.0, 1.0), U.mood);
  // Banks differ wildly in luminance at the same t. Tame the extremes only.
  c *= clamp(0.34 / max(luma(c), 1e-3), 0.65, 1.8);
  // A little more colour than the ramp carries: these are lights, not silk.
  return max(mix(vec3f(luma(c)), c, 1.3), vec3f(0.0));
}

// -- backdrop -----------------------------------------------------------------

/** Near-black. A broad off-centre gradient in the mood's colour, and nothing
 *  else: no centre glow, no fog, no visible noise. */
@fragment
fn bgFs(in : FullOut) -> @location(0) vec4f {
  let cam = cameraAt(U.voyageZ);
  let unit = (in.uv - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let dir = viewToDir(normalize(vec3f(unit / cam.proj, 1.0)), cam);

  let quiet = clamp(U.lull * 0.8 + U.breath * 0.2, 0.0, 1.0);
  // Deep space with an atmosphere: a floor the mood tints, never black.
  var col = vec3f(0.004, 0.006, 0.012) + palette(0.12, U.mood) * 0.06;
  // Two broad veils, off centre and fixed in the world, so they slide as the
  // flight turns. Lit a little by the low bands and by an instrument's entry.
  let glow = exp(-acos(clamp(dot(dir, normalize(vec3f(0.45, 0.35, 0.82))), -1.0, 1.0)) * 1.4);
  let lift = (0.05 + U.bass * 0.02 + U.entry * 0.015) * mix(1.0, 0.6, quiet);
  col += palette(0.32, U.mood) * glow * lift;
  let low = exp(-acos(clamp(dot(dir, normalize(vec3f(-0.5, -0.4, 0.77))), -1.0, 1.0)) * 1.8);
  col += palette(0.22, U.mood) * low * 0.03 * mix(1.0, 0.6, quiet);
  return vec4f(col, 1.0);
}

// -- lights -------------------------------------------------------------------

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) local    : vec2f,   // capsule-local, x along the streak, in radii
  @location(1) halfLen  : f32,     // streak half length, in radii
  @location(2) color    : vec3f,
  @location(3) alpha    : f32,
  @location(4) radiusPx : f32,
  @location(5) kind     : f32,     // 0 point, 1 disc, 2 disc with a highlight
  @location(6) rim      : f32,
};

fn hidden() -> VSOut {
  var o : VSOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  o.alpha = 0.0;
  return o;
}

fn quadCorner(vi : u32) -> vec2f {
  var quad = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, 1.0));
  return quad[vi];
}

// Discs carry a soft skirt well beyond their edge, so the quad is drawn wider
// than the disc. Local coordinates are in disc radii throughout.
const SKIRT : f32 = 2.2;

/** Builds the sprite once its screen placement is known. `centre` and `axis`
 *  are in unit space; `radiusPx` and `halfLenPx` are in pixels. */
fn sprite(vi : u32, centre : vec2f, axis : vec2f, radiusPx : f32, halfLenPx : f32,
          color : vec3f, alpha : f32, kind : f32, rim : f32) -> VSOut {
  let px = 2.0 / U.resolution.y;
  let radius = radiusPx * px;
  let quad = radius * select(1.0, SKIRT, kind > 0.5);
  let halfLen = halfLenPx * px;
  let q = quadCorner(vi);
  let perp = vec2f(-axis.y, axis.x);
  let off = axis * (q.x * (halfLen + quad)) + perp * (q.y * quad);
  let unit = centre + off;
  let pad = halfLen + quad;
  if (abs(centre.x) > U.aspect + pad || abs(centre.y) > 1.0 + pad) { return hidden(); }
  var o : VSOut;
  o.pos = vec4f(unit.x / U.aspect, unit.y, 0.0, 1.0);
  o.local = vec2f(q.x * (halfLen + quad) / radius, q.y * quad / radius);
  o.halfLen = halfLen / radius;
  o.color = color;
  o.alpha = alpha;
  o.radiusPx = radiusPx;
  o.kind = kind;
  o.rim = rim;
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  let cam = cameraAt(U.voyageZ);
  let pxScale = U.resolution.y / 1080.0;   // lens constants are stated at 1080p
  let skyCount = u32(U.voyageB.z);
  let pathCount = u32(U.voyageB.w);
  let seed = u32(U.seedTime * 977.0);

  // -- the sky: at infinity, so only the turn moves it ----------------------
  if (ii < skyCount) {
    let h = hash3u(ii * 2654435761u + seed);
    let h2 = hash3u(ii * 40503u + 7u + seed);
    let zc = h.x * 2.0 - 1.0;
    let rr = sqrt(max(0.0, 1.0 - zc * zc));
    let dir = vec3f(rr * cos(h.y * TAU), rr * sin(h.y * TAU), zc);
    let v = dirToView(dir, cam);
    if (v.z < 0.08) { return hidden(); }
    let centre = project(v, cam.proj);
    // A few bright, most faint; a slow twinkle nobody could point to.
    let mag = pow(h.z, 3.0);
    let twinkle = 0.85 + 0.15 * sin(U.time * (0.3 + h2.x * 0.7) + h2.y * 40.0);
    let radiusPx = (1.0 + mag * 1.2) * pxScale;
    let quiet = mix(1.0, 0.7, U.lull);
    let color = mix(lightColour(0.5, h2.z), vec3f(0.9, 0.95, 1.0), 0.6);
    let alpha = (0.12 + mag * 0.90) * twinkle * quiet * (0.85 + U.high * 0.25);
    return sprite(vi, centre, vec2f(1.0, 0.0), radiusPx, 0.0, color, alpha, 0.0, 0.0);
  }

  // -- the field ------------------------------------------------------------
  let i = ii - skyCount;
  if (i >= pathCount) { return hidden(); }
  let z = U.voyageZ;

  // Where along the window this light sits, and which wrap it is on.
  let base = hash3u(i * 2246822519u + 13u).x * WINDOW;
  let k = floor((z - BACK - base) / WINDOW) + 1.0;
  let s = base + k * WINDOW;
  let wrap = u32(k - WRAPS * floor(k / WRAPS));
  let key = i + wrap * 65536u + seed;
  let h = hash3u(key);
  let h2 = hash3u(key * 3266489917u + 1u);
  let h3 = hash3u(key * 668265263u + 2u);

  // 87.5% dust, ~11% lanterns, ~1.5% heroes.
  let dustCount = u32(f32(pathCount) * 0.875);
  let lanternCount = u32(f32(pathCount) * 0.1094);
  var population = 0u;
  if (i >= dustCount + lanternCount) { population = 2u; }
  else if (i >= dustCount) { population = 1u; }

  // The field has to be wide compared with how far into it you can see, or
  // its far end collapses into a clump at the vanishing point and the whole
  // thing reads as a tunnel again.
  // Each population fills a disc wider than the depth you can see into it.
  // Seen deeper than it is wide, a field bunches into the middle of the
  // frame - the far half of the window all lands in one central ellipse -
  // and a profile that thins toward the rim leaves the frame edges empty.
  // So: uniform across the disc, faded out by 1.4 reach, and the disc 1.2x
  // wider than that, which keeps a ray at the corner of the frame inside the
  // field for as long as a ray down the centre.
  var rMin = 0.30; var reach = 40.0;
  var aperture = 1.2; var rDiff = 0.8; var geom = 2.0; var rClampMin = 0.9; var rClampMax = 14.0;
  var maxStreak = 18.0; var rRef = 1.4; var peak = 0.55; var kind = 0.0; var rim = 0.0;
  if (population == 1u) {
    // Lanterns are the point of the flight: glowing orbs that pass, and
    // swell into soft discs as they come close.
    rMin = 0.80; reach = 22.0;
    aperture = 8.0; rDiff = 1.0; geom = 12.0; rClampMin = 1.4; rClampMax = 110.0;
    maxStreak = 10.0; rRef = 3.0; peak = 1.8; kind = 1.0; rim = 0.14;
  }
  if (population == 2u) {
    rMin = 1.2; reach = 22.0;
    aperture = 10.0; rDiff = 1.2; geom = 20.0; rClampMin = 1.8; rClampMax = 160.0;
    maxStreak = 5.0; rRef = 4.5; peak = 2.6; kind = 2.0; rim = 0.26;
  }
  let depth = reach * 1.4;
  let rMax = depth * 1.2;
  aperture *= U.voyageB.y;
  // No two lights the same size or the same brightness.
  let vary = 0.6 + h2.z * 0.8;
  geom *= vary;

  let r = rMax * sqrt(h.x);
  let ang = h.y * TAU;
  let lateral = vec2f(cos(ang), sin(ang)) * r;
  let lane = smoothstep(rMin, rMin * 2.2, r);

  let f = frameAt(s);
  let world = pathAt(s) + f.n * lateral.x + f.b * lateral.y;
  let v = dirToView(world - cam.pos, cam);
  if (v.z < 0.05) { return hidden(); }
  let d = length(v);
  let centre = project(v, cam.proj);

  // Where the same light sat a short shutter ago. Only the camera moved.
  let cam0 = cameraAt(z - U.voyageA.x * 0.020);
  let v0 = dirToView(world - cam0.pos, cam0);
  let centre0 = project(v0, cam.proj);
  let deltaPx = (centre - centre0) * U.resolution.y * 0.5;
  let travel = length(deltaPx);
  let axis = select(vec2f(1.0, 0.0), deltaPx / max(travel, 1e-6), travel > 0.35);

  // The lens. A thin-lens circle of confusion in pixels, on top of a core that
  // is the light's own size until diffraction wins.
  let focus = U.voyageB.x;
  let coc = aperture * abs(focus / d - 1.0) * pxScale;
  let core = sqrt(rDiff * rDiff * pxScale * pxScale + (geom * pxScale / d) * (geom * pxScale / d));
  let radiusPx = clamp(sqrt(core * core + coc * coc), rClampMin * pxScale, rClampMax * pxScale);
  // Never below a pixel: shimmer. Pay for it in energy instead.
  let drawnPx = max(radiusPx, 0.9);
  let rasterGain = (radiusPx * radiusPx) / (drawnPx * drawnPx);

  // Streak: a short shutter, soft-limited so a near pass never becomes a bar,
  // and shorter still on big discs, which motion would only smear.
  var halfLenPx = 0.5 * maxStreak * (1.0 - exp(-travel / maxStreak));
  halfLenPx *= clamp(4.0 / drawnPx, 0.25, 1.0);
  if (halfLenPx < 0.35) { halfLenPx = 0.0; }

  // Ink. A streak spreads the same light over a longer capsule; a defocused
  // disc is dimmer than the point it came from, though not strictly so - a
  // rare close disc should still be seen.
  let streakGain = (3.14159 * drawnPx * drawnPx)
                   / (3.14159 * drawnPx * drawnPx + 4.0 * drawnPx * halfLenPx);
  let cocGain = clamp(pow(rRef * pxScale / max(drawnPx, rRef * pxScale), 1.1), 0.14, 1.0);
  // Distance dims, then cuts off. The sky is what lies beyond.
  let fall = (1.0 - smoothstep(reach * 0.8, depth, d)) / (1.0 + (d / reach) * (d / reach));

  // Each light listens to its own part of the spectrum, gently, with a floor
  // so the journey goes on through silence.
  let bin = spectrum[u32(clamp(h2.x, 0.0, 0.999) * BINS)];
  let listen = 0.32 + 0.68 * pow(max(bin, 0.0), 0.8);
  let slow = 1.0 + 0.045 * sin(U.time * (0.25 + h2.y * 0.3) + h2.z * 30.0);

  let near = smoothstep(24.0, 4.0, d);
  let onsetPick = step(0.75, h3.x);
  var event = 1.0 + U.onset * 0.16 * onsetPick * near + U.entry * 0.14 * near;
  if (population == 2u) { event += U.beat * exp(-U.beatAge * 4.0) * 0.05; }
  if (population == 0u) { event *= mix(0.82, 1.0, U.musicDensity) * (0.9 + U.high * 0.12); }
  if (population > 0u) { event *= 1.0 + U.voicePresence * 0.08; }

  let nearFade = smoothstep(0.45, 1.25, v.z);
  let farFade = 1.0 - smoothstep(WINDOW - BACK - 12.0, WINDOW - BACK, s - z);
  let quiet = mix(1.0, select(0.55, 0.78, population > 0u), U.lull) * (1.0 - U.breath * 0.08);
  let countGain = 12288.0 / f32(pathCount);

  let alpha = peak * (0.7 + h2.z * 0.6) * listen * slow * event * nearFade * farFade * fall
              * lane * quiet * countGain * rasterGain * streakGain * cocGain;
  if (alpha < 0.0004) { return hidden(); }

  let color = lightColour(h3.y, h3.z);
  return sprite(vi, centre, axis, drawnPx, halfLenPx, color, alpha, kind, rim);
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // Capsule distance field, in radii.
  let rho = length(vec2f(max(abs(in.local.x) - in.halfLen, 0.0), in.local.y));
  let w = clamp(1.25 / in.radiusPx, 0.035, 0.16);
  let envelope = 1.0 - smoothstep(1.0 - 2.0 * w, 1.0, rho);
  var a : f32;
  if (in.kind < 0.5) {
    a = exp(-3.2 * rho * rho) * envelope;
  } else {
    // A mostly flat disc with a soft edge and a restrained bright rim, as a
    // lens draws a point it cannot focus.
    let fill = (0.72 + 0.28 * (1.0 - rho * rho)) * envelope;
    let sr = clamp(1.4 / in.radiusPx, 0.055, 0.16);
    let ring = in.rim * exp(-0.5 * pow((rho - 0.78) / sr, 2.0)) * envelope;
    // The glow: a gaussian skirt reaching SKIRT radii out, faint at the edge
    // of the quad so the cut never shows.
    let skirt = 0.22 * exp(-rho * rho * 0.8);
    a = fill + ring + skirt;
    if (in.kind > 1.5) {
      // Heroes keep a compact highlight that survives focus, so a sharp hero
      // can enter the bloom while a defocused one becomes a true disc.
      let dPx = rho * in.radiusPx;
      a += 1.4 * exp(-0.5 * dPx * dPx) * exp(-in.radiusPx / 18.0);
    }
  }
  a *= in.alpha;
  if (a < 0.0002) { discard; }
  return vec4f(in.color * a, a);
}
