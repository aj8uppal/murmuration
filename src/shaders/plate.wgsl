// Plate: sand on a vibrating plate, seen from above.
//
// The plate rings in a superposition of its modes, chosen by the music:
// the strongest few spectral peaks each pick a mode (m, n) by pitch and
// set its amplitude by their energy, so the nodal lines shift with every
// note. Grains slide down the gradient of the vibration's energy - the
// square of the summed mode shapes - and are shaken in proportion to the
// vibration where they stand, so they gather on the nodal lines: a figure
// forms while a chord holds, crisp in a lull, and dissolves and reforms
// when the harmony moves. A beat kicks the sand and it hops and settles
// again. Matte grains on slate under a raking light from the upper left:
// a density map of the sand, built each frame, lights the ridges on one
// side and shadows the plate beside them.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;
@group(0) @binding(2) var<storage, read> M : array<f32>;
@group(0) @binding(3) var<storage, read_write> grains : array<vec4f>;
// The same buffer, read only, for the draws: a vertex stage may not bind
// read-write storage.
@group(0) @binding(4) var<storage, read> grainsRead : array<vec4f>;
@group(0) @binding(5) var density : texture_2d<f32>;
@group(0) @binding(6) var densitySampler : sampler;

const HEADER : u32 = 16u;
const PI : f32 = 3.14159265359;
// The plate spans this much of the frame's height, centred.
const PLATE : f32 = 0.80;

/** The raking light, from the upper left, breathing a little with the
 *  bass. */
fn lightDir() -> vec2f {
  let a = 2.21 + 0.18 * M[9];
  return vec2f(cos(a), sin(a));
}

struct Field { psi : f32, grad : vec2f, shake : f32 };

/** The summed mode shapes at p (plate coordinates -1..1) and their
 *  gradient; and how hard the plate shakes there. */
fn fieldAt(p : vec2f, count : u32) -> Field {
  var f : Field;
  for (var k = 0u; k < count; k++) {
    let b = HEADER + k * 4u;
    let m = M[b];  let n = M[b + 1u];  let a = M[b + 2u];  let sym = M[b + 3u];
    let cx = cos(m * PI * 0.5 * (p.x + 1.0));  let sx = sin(m * PI * 0.5 * (p.x + 1.0));
    let cy = cos(n * PI * 0.5 * (p.y + 1.0));  let sy = sin(n * PI * 0.5 * (p.y + 1.0));
    let cx2 = cos(n * PI * 0.5 * (p.x + 1.0));  let sx2 = sin(n * PI * 0.5 * (p.x + 1.0));
    let cy2 = cos(m * PI * 0.5 * (p.y + 1.0));  let sy2 = sin(m * PI * 0.5 * (p.y + 1.0));
    f.psi += a * (cx * cy + sym * cx2 * cy2);
    f.grad += a * vec2f(
      -m * PI * 0.5 * sx * cy - sym * n * PI * 0.5 * sx2 * cy2,
      -n * PI * 0.5 * cx * sy - sym * m * PI * 0.5 * cx2 * sy2);
    f.shake += abs(a);
  }
  return f;
}

@compute @workgroup_size(64)
fn simMain(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= u32(U.particleCount)) { return; }
  var g = grains[i];
  var p = g.xy;
  var v = g.zw;
  let dt = M[1];
  let agitation = M[2];    // how hard the plate shakes: the bass and the level
  let kick = M[3];         // a beat's throw, decaying
  let diffusion = M[4];    // less in a lull
  let seed = M[5];
  let f = fieldAt(p, u32(M[0]));
  // Down the energy's gradient - toward the nodes - at a pace that lets a
  // moving line carry its sand with it rather than snap; shaken where the
  // plate moves, in proportion to its motion there, a little everywhere,
  // so no grain freezes off a node. The shake is a random impulse per
  // step, so it scales with the square root of the step.
  let force = -2.0 * f.psi * f.grad * 2.2;
  let h = hash22(vec2f(f32(i) * 0.6180339 + seed * 0.37, seed + f32(i) * 1e-3));
  let ang = h.x * 6.28318;
  let jitter = vec2f(cos(ang), sin(ang)) * (h.y * 2.0 - 1.0);
  let shake = (0.03 + abs(f.psi) * 1.1) * agitation * diffusion + kick * (0.2 + 0.6 * abs(f.psi));
  v += force * dt + jitter * shake * 0.5 * sqrt(dt * 60.0);
  v *= exp(-dt * 8.0);
  p += v * dt;
  // The plate's edge: the sand bounces softly off the rim, and a grain
  // thrown further than the reflection reaches is held at it.
  if (p.x < -1.0) { p.x = -2.0 - p.x; v.x = abs(v.x) * 0.5; }
  if (p.x > 1.0) { p.x = 2.0 - p.x; v.x = -abs(v.x) * 0.5; }
  if (p.y < -1.0) { p.y = -2.0 - p.y; v.y = abs(v.y) * 0.5; }
  if (p.y > 1.0) { p.y = 2.0 - p.y; v.y = -abs(v.y) * 0.5; }
  p = clamp(p, vec2f(-1.0), vec2f(1.0));
  grains[i] = vec4f(p, v);
}

// -- the density map ------------------------------------------------------------

struct DensityOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
};

/** Every grain, as a soft dot in plate space, added into the map. */
@vertex
fn densityVs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> DensityOut {
  var o : DensityOut;
  let g = grainsRead[ii];
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  // A texel and a half across on a map a few hundred texels wide.
  let r = 1.6 / 384.0;
  o.pos = vec4f(g.xy + corner * r, 0.0, 1.0);
  o.local = corner;
  return o;
}

@fragment
fn densityFs(in : DensityOut) -> @location(0) vec4f {
  let w = max(0.0, 1.0 - dot(in.local, in.local));
  return vec4f(w, 0.0, 0.0, 1.0);
}

/** The map's texture coordinates of a plate position. */
fn mapUv(p : vec2f) -> vec2f {
  return vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}

/** Sand height and its slope at p, from the map, in units of the map's
 *  expected mean so the look does not depend on the preset: three taps,
 *  the slope by one-sided differences, which is all a raking light needs. */
fn heightAt(p : vec2f) -> vec3f {
  let uv = mapUv(p);
  let e = 2.0 / 384.0;
  let norm = 1.0 / max(M[6], 1e-3);
  let c = textureSampleLevel(density, densitySampler, uv, 0.0).r * norm;
  let dx = textureSampleLevel(density, densitySampler, uv + vec2f(e, 0.0), 0.0).r * norm - c;
  let dy = c - textureSampleLevel(density, densitySampler, uv + vec2f(0.0, e), 0.0).r * norm;
  return vec3f(c, dx, dy);
}

// -- the plate and the sand ---------------------------------------------------

/** Slate: a dark grey-green plate under the raking light, a brushed
 *  grain, a bevelled rim raised a little above it, the surround falling to
 *  black; the sand's contact shadow on it, and the faintest sheen of the
 *  plate's own vibration, so the harmony registers the instant it changes
 *  while the sand takes its seconds to follow. */
@fragment
fn bgFs(in : FullOut) -> @location(0) vec4f {
  let unit = (in.uv - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let p = unit / PLATE;
  let px = 2.0 / U.resolution.y / PLATE;
  let edge = max(abs(p.x), abs(p.y));
  let bevel = 11.0 * px;
  let inside = 1.0 - smoothstep(1.0, 1.0 + 0.5 * px, edge);
  let light = lightDir();
  let grain = (hash22(in.pos.xy * 0.53).x - 0.5) * 0.010 + (hash22(floor(in.pos.xy * 0.09) + 3.0).y - 0.5) * 0.006;
  // The light falls from the upper left and off toward the far corner.
  let lightFall = 0.80 + 0.20 * smoothstep(-1.2, 1.6, dot(p, light)) - 0.16 * length(p) * length(p);
  var slate = vec3f(0.048, 0.052, 0.054) * (1.0 + grain * 6.0) * lightFall;
  // The plate's own vibration: antinodes a shade lighter, a sheen that
  // moves with the music before the sand does.
  let f = fieldAt(clamp(p, vec2f(-1.0), vec2f(1.0)), u32(M[10]));
  slate *= 1.0 + 0.07 * (1.0 - exp(-2.0 * abs(f.psi)));
  // Where the sand lies, the plate beside it falls into its shadow.
  let hgt = heightAt(clamp(p, vec2f(-1.0), vec2f(1.0)));
  let shadow = smoothstep(0.3, 1.8, hgt.x) * 0.22 + smoothstep(0.0, 0.8, -(hgt.y * light.x + hgt.z * light.y)) * 0.14;
  slate *= 1.0 - shadow;
  // The bevel: the rim rises toward the edge and catches the light on the
  // side facing it.
  let inBevel = smoothstep(1.0 - bevel, 1.0, edge);
  let rimNormal = select(vec2f(sign(p.x), 0.0), vec2f(0.0, sign(p.y)), abs(p.y) > abs(p.x));
  let rimLit = 0.9 + 0.5 * dot(rimNormal, light);
  slate = mix(slate, vec3f(0.075, 0.078, 0.080) * rimLit, inBevel * 0.85);
  let surround = vec3f(0.004, 0.004, 0.005) * (1.0 - 0.6 * smoothstep(1.0, 1.9, length(unit)));
  return vec4f(mix(surround, slate, inside), 1.0);
}

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
  @location(1) tone : f32,
  @location(2) light : f32,
  @location(3) dense : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  var o : VSOut;
  let g = grainsRead[ii];
  let px = 2.0 / U.resolution.y;
  // A grain a little over a pixel across, its size varying by grain, and
  // its face lit by the raking light according to the slope of the sand
  // it lies on: ridges bright on the lit side, dim on the far side.
  let h = hash22(vec2f(f32(ii) * 0.7548776, 0.5));
  // Mostly under a pixel, with one grain in eight larger, for the hand's
  // sense of grit; a beat lifts every grain for an instant, larger and
  // displaced from its shadow toward the light.
  let big = step(0.875, h.x);
  let hop = M[8];
  let r = mix(0.55 + 0.35 * h.x, 1.2 + 0.6 * h.x, big) * px * (U.resolution.y / 1000.0) * 1.15 * (1.0 + 0.18 * hop);
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let light = lightDir();
  let centre = g.xy * PLATE + light * (hop * 4.0 * px);
  let uv = centre + corner * r * 1.5;
  let hgt = heightAt(g.xy);
  let slope = vec2f(hgt.y, hgt.z);
  let lit = dot(normalize(slope + vec2f(1e-5, 0.0)), light) * smoothstep(0.0, 0.8, length(slope));
  o.pos = vec4f(uv.x / U.aspect, uv.y, 0.0, 1.0);
  o.local = corner * 1.5;
  o.tone = h.y;
  o.light = lit;
  // Grains under the rim's bevel are hidden by it.
  let edge = max(abs(g.x), abs(g.y));
  o.dense = hgt.x + 100.0 * step(1.0 - 11.0 * px / PLATE, edge);
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let d = length(in.local);
  let cover = 1.0 - smoothstep(0.7, 1.3, d);
  if (cover < 0.01) { discard; }
  if (in.dense > 50.0) { discard; }
  // Warm sand, each grain its own shade - cream to tan - lit on the ridge
  // side and shadowed on the far side, a little brighter where it piles
  // above the mean; the ink per grain is normalised across presets.
  var sand = mix(vec3f(0.60, 0.50, 0.37), vec3f(0.88, 0.80, 0.64), in.tone);
  sand *= 0.72 + 0.40 * in.light + 0.12 * smoothstep(1.4, 3.0, in.dense);
  let alpha = cover * 0.85 * M[7];
  return vec4f(sand * alpha, alpha);
}
