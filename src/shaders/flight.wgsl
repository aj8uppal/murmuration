// The flight, shared by the modes that move through space: the voyage's
// periodic path and the camera that breathes along it, integer hashing, the
// clip depth and the cool palette. Prepended after common.wgsl to voyage.wgsl
// and current.wgsl.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;

// The path repeats after this many units; the CPU keeps the travelled
// distance inside it. Every mode's wrap window must divide it.
const PERIOD : f32 = 12288.0;

// Every path frequency is an integer multiple of this, which is what makes the
// path periodic in PERIOD.
const K : f32 = 6.28318530718 / PERIOD;

// Vertical field of view is fixed at 52 degrees. Optics that never move are a
// large part of what makes a flight tranquil.
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

/** Long, gentle bends: about thirteen degrees of heading and five of pitch,
 *  on curves so wide that the heading turns about a degree a second at
 *  cruising speed and two at full speed. Short bends at this speed felt
 *  like swerving. */
fn pathAt(s : f32) -> vec3f {
  return vec3f(
    sin(s * (4.0 * K)) * 75.0 + sin(s * (7.0 * K) + 1.3) * 23.0,
    sin(s * (3.0 * K) + 0.8) * 32.7 + sin(s * (5.0 * K) + 2.4) * 11.9,
    s);
}

fn pathTangent(s : f32) -> vec3f {
  return normalize(vec3f(
    cos(s * (4.0 * K)) * (75.0 * 4.0 * K) + cos(s * (7.0 * K) + 1.3) * (23.0 * 7.0 * K),
    cos(s * (3.0 * K) + 0.8) * (32.7 * 3.0 * K) + cos(s * (5.0 * K) + 2.4) * (11.9 * 5.0 * K),
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

/** The camera at distance z, as it was `back` seconds ago: the gaze is
 *  rewound by its rates, so a trail drawn from the previous pose carries the
 *  turn as well as the travel. */
fn cameraAt(z : f32, back : f32) -> Camera {
  var c : Camera;
  c.pos = pathAt(z);
  // The camera looks down the road, not along the instantaneous tangent: at
  // a point about a second ahead, which anticipates a bend the way a driver
  // does and turns the heading through it smoothly.
  // Among the strands the look-ahead is about a second of travel at any
  // speed: a fast passage anticipates a bend as much as a slow one.
  let ahead = select(8.0 + U.voyageA.x * 0.8, clamp(6.0 + U.voyageA.x * 0.7, 9.0, 22.0), U.mode > 1.5);
  let t = normalize(pathAt(z + ahead) - c.pos);
  let n = normalize(cross(vec3f(0.0, 1.0, 0.0), t));
  c.f = Frame(t, n, cross(t, n));
  // Only the user's own zoom, never the particle camera's drift and punch.
  c.proj = PROJ * U.voyageZoom;
  c.yaw = U.voyageA.y - U.voyageC.x * back;
  c.pitch = U.voyageA.z - U.voyageC.y * back;
  // The music's turn banks on the CPU, in proportion to the turn rate; the
  // path's own bends add the lean their lateral acceleration earns.
  let curvature = (pathTangent(z + 2.0) - pathTangent(z - 2.0)) * 0.25;
  let lateralAccel = U.voyageA.x * U.voyageA.x * dot(curvature, n);
  // A soft limit: a hard one held the bank flat at its stop through a bend.
  let bend = 0.05 * tanh(atan(lateralAccel / 4.0) / 0.05);
  c.roll = U.voyageA.w - U.voyageC.z * back - bend;
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

// The flight's depth range, for the depth buffer that gives crossings an
// owner: a form in front hides what lies behind it.
const NEAR_CLIP : f32 = 0.3;
const FAR_CLIP  : f32 = 300.0;

/** Normalised device depth of a view depth, 0 at the near plane and 1 at
 *  the far, the usual hyperbolic mapping. Below the near plane it goes
 *  negative and the hardware clips it away. */
fn depthOf(zv : f32) -> f32 {
  return FAR_CLIP * (zv - NEAR_CLIP) / ((FAR_CLIP - NEAR_CLIP) * max(zv, 1e-4));
}

// -- palette ------------------------------------------------------------------

/** The mood, on the cool banks only: ocean, aurora, silver, neon. The ember
 *  bank is left to the lanterns - a whole field of it, warm on a warm sky,
 *  has no counterpoint, and a lo-fi night is cool with warm lights in it. */
fn coolPalette(t : f32, mood : f32) -> vec3f {
  let m = clamp(mood, 0.0, 4.0) * 0.75;
  let f = smoothstep(0.08, 0.92, fract(m));
  if (m < 1.0) { return mix(paletteOcean(t), paletteAurora(t), f); }
  if (m < 2.0) { return mix(paletteAurora(t), paletteSilver(t), f); }
  return mix(paletteSilver(t), paletteNeon(t), smoothstep(0.08, 0.92, m - 2.0));
}

/** Three anchors, not the whole ramp: a dominant hue, a supporting one, and a
 *  rare accent. Spectrum decides brightness, never hue - 128 bands of colour
 *  would be confetti. */
fn lightColour(pick : f32, jitter : f32) -> vec3f {
  var anchor = 0.52;
  if (pick > 0.72) { anchor = 0.72; }
  if (pick > 0.95) { anchor = 0.94; }
  let t = anchor + (jitter - 0.5) * 0.036 + U.musicalMode * 0.015 + U.warmth * 0.03;
  var c = coolPalette(clamp(t, 0.0, 1.0), U.mood);
  // Banks differ wildly in luminance at the same t. Tame the extremes only.
  c *= clamp(0.34 / max(luma(c), 1e-3), 0.65, 1.8);
  // A little more colour than the ramp carries: these are lights, not silk.
  return max(mix(vec3f(luma(c)), c, 1.15), vec3f(0.0));
}

