// Warp: a tunnel flown through, driven and steered by the music.
//
// A sleeve of haze on the tunnel's walls, hoops of mist along it at no
// regular interval, faint threads running its length, and a field of stars
// inside and beyond it, seen from a camera that travels down its axis
// toward the light at the far end. The haze is a fullscreen pass drawn
// small and expanded, like the particle backdrop; every hoop, thread sample
// and star is derived in the vertex stage from its instance index, a hash,
// and the distance travelled. All of it lands in the same HDR target as the
// particles so the bloom chain and the grade are shared.
//
// Nothing here answers the tempo tracker. What is immediate answers the
// onset - the transient the analyser actually heard - and gently; the rest
// follows the slow envelopes, so the piece breathes rather than blinks.
//
// The tunnel is built in the camera's own frame. Ahead of the camera it is a
// circular arc whose curvature vector the CPU sets from the music - the
// melody's lean bends it up and down, the phrases sweep it left and right -
// and a point at arc distance d ahead sits on that arc, in a frame carried
// along it. When the curvature is steady the camera's travel along the arc
// is exactly consistent, so everything sweeps past the way it would in a real
// bend; when it changes, the road ahead visibly re-bends toward the new
// direction, which is the point: the music is seen to steer.
//
// The travel wraps in WPERIOD, which every distance-periodic thing here
// divides, so the wrap is invisible and float precision holds however long
// the flight.

const R : f32 = 10.0;                   // the tunnel's radius
const FAR : f32 = 400.0;                // how far ahead it is drawn
const RING_SPACING : f32 = 14.0;        // on average: each hoop sits off its station by up to 40%
const RINGS_PER_PERIOD : u32 = 549u;    // WPERIOD / RING_SPACING, rounded: hoop identity repeats with the travel
const SIDES : u32 = 64u;
const RAIL_SEGS : u32 = 96u;
const WPERIOD : f32 = 7680.0;
const STAR_WINDOW : f32 = 480.0;        // stars live in a window around the camera
const STAR_BACK : f32 = 6.0;            // of which, this much lies behind it
const STAR_WRAPS : u32 = 16u;
const TWIST : f32 = TAU * 12.0 / 7680.0;   // the lattice corkscrews: a turn every 640 units
const HALO : f32 = 8.0;                 // strip half-width in sigmas of the line
const PROJ_W : f32 = 2.0503;            // 52 degrees vertical

// -- the tunnel ---------------------------------------------------------------

/** A point of the tunnel in the camera's frame: on the arc at distance d,
 *  offset across it by `lateral` in the frame carried along the arc. The
 *  arc rotates the camera's z toward the curvature's direction about the
 *  axis perpendicular to both, and the frame rotates with it. */
fn tunnelPoint(d : f32, lateral : vec2f) -> vec3f {
  let kap = U.warpB.xy;
  let k = length(kap);
  if (k < 1e-5) { return vec3f(lateral, d); }
  let u = kap / k;
  let a = k * d;
  let ca = cos(a);
  let sa = sin(a);
  let axis = vec3f(-u.y, u.x, 0.0);
  let centre = vec3f(u * ((1.0 - ca) / k), sa / k);
  let l3 = vec3f(lateral, 0.0);
  let rot = l3 * ca + cross(axis, l3) * sa + axis * (dot(axis, l3) * (1.0 - ca));
  return centre + rot;
}

/** The gaze - looking into the bend - and the bank, on top of the arc. */
fn toView(p : vec3f) -> vec3f {
  var v = p;
  let cy = cos(U.warpB.z); let sy = sin(U.warpB.z);
  v = vec3f(v.x * cy - v.z * sy, v.y, v.x * sy + v.z * cy);
  let cp = cos(U.warpB.w); let sp = sin(U.warpB.w);
  v = vec3f(v.x, v.y * cp - v.z * sp, v.y * sp + v.z * cp);
  let cr = cos(U.warpC.x); let sr = sin(U.warpC.x);
  return vec3f(v.x * cr - v.y * sr, v.x * sr + v.y * cr, v.z);
}

/** Into unit space: y in -1..1, x in -aspect..aspect. */
fn projectW(v : vec3f) -> vec2f {
  return v.xy * (PROJ_W * U.voyageZoom / max(v.z, 1e-3));
}

/** Clip position of a unit-space point at view depth z, with w = z so that
 *  what is interpolated along a strip is interpolated in depth. */
fn clipAt(unit : vec2f, z : f32) -> vec4f {
  return vec4f(unit.x * z / U.aspect, unit.y * z, 0.5 * z, z);
}

/** The onsets' waves: broad, faint swells of light sent down the tunnel
 *  from the camera on a transient, in travel units, wrapping with the
 *  period. */
fn pulseAt(s : f32) -> f32 {
  var d1 = s - U.warpD.x;  d1 -= WPERIOD * round(d1 / WPERIOD);
  var d2 = s - U.warpD.z;  d2 -= WPERIOD * round(d2 / WPERIOD);
  d1 /= 16.0;  d2 /= 16.0;
  return U.warpD.y * exp(-0.5 * d1 * d1) + U.warpD.w * exp(-0.5 * d2 * d2);
}

/** The spectrum at an angle around the tunnel, mirrored: the bass at the
 *  floor, the top of the band at the ceiling. Averaged over the bins the
 *  segment spans, so a narrow peak is not missed between the sides. */
fn spectrumAt(theta0 : f32, theta1 : f32) -> f32 {
  let t0 = pow(0.5 + 0.5 * sin(theta0), 1.15);
  let t1 = pow(0.5 + 0.5 * sin(theta1), 1.15);
  let lo = u32(clamp(min(t0, t1), 0.0, 0.999) * BINS);
  let hi = max(u32(clamp(max(t0, t1), 0.0, 0.999) * BINS), lo + 1u);
  var sum = 0.0;
  for (var b = lo; b < hi; b++) { sum += spectrum[b]; }
  return sum / f32(hi - lo);
}

/** The lattice's own colour: the mood's cool bank, a little toward white. */
fn latticeColour() -> vec3f {
  var c = coolPalette(0.58 + U.warmth * 0.04, U.mood);
  c *= clamp(0.36 / max(luma(c), 1e-3), 0.7, 1.8);
  // A little more colour than the ramp carries: these are lights.
  c = max(mix(vec3f(luma(c)), c, 1.2), vec3f(0.0));
  return mix(c, vec3f(0.9, 0.94, 1.0), 0.12);
}

// -- the haze -----------------------------------------------------------------

/** Where the eye ray through `unit` meets the tube: its depth along the
 *  tunnel, its angle around the tube, and its distance on screen from the
 *  tube's axis there. Solved on the bent arc by a few fixed-point steps
 *  from the straight tube's answer: the axis moves across the screen with
 *  depth, slowly enough for that to settle. */
fn wallAt(unit : vec2f) -> vec3f {
  let proj = PROJ_W * U.voyageZoom;
  var d = FAR * 0.8;
  var axis = vec2f(0.0);
  for (var i = 0; i < 4; i++) {
    axis = projectW(toView(tunnelPoint(d, vec2f(0.0))));
    d = clamp(R * proj / max(length(unit - axis), 1e-3), 1.0, FAR);
  }
  let rel = unit - axis;
  return vec3f(d, atan2(rel.y, rel.x) - U.warpC.x, length(rel));
}

/** The walls: a sleeve of cloud in the tunnel's own coordinates - long
 *  along the travel, narrow around it - streaming past, lit around its
 *  circumference by the spectrum, breathing with the bass, dim right
 *  beside the lens and dissolving far ahead into the core: the light at
 *  the far end that swells with the burn. Drawn small and expanded. */
@fragment
fn hazeFs(in : FullOut) -> @location(0) vec4f {
  let unit = (in.uv - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let wall = wallAt(unit);
  let d = wall.x;
  let th = wall.y;
  let boost = U.warpA.z;
  let b2 = boost * boost;

  // The cloud, turning with the lattice and drifting slowly of its own
  // accord; a coarser field over it for the wisps, and slow bands of hue
  // along the tunnel.
  let along = (d + U.warpG.x) * 0.016 * (1.0 - 0.45 * boost);
  let ring = vec2f(cos(th - U.warpA.w), sin(th - U.warpA.w));
  let q = vec3f(ring * 1.5, along + U.time * 0.02);
  let n1 = fbm3(q, 3);
  let n2 = fbm3(q * vec3f(2.1, 2.1, 1.7) + vec3f(3.7, 1.9, 11.0 - U.time * 0.03), 2);
  let veil = smoothstep(-0.30, 0.50, n1 + 0.45 * n2);
  let hue = fbm3(vec3f(ring * 0.6, along * 0.35 + 7.0), 2);

  // The spectrum at this angle - the slow one - lights the wall, the bass
  // breathes it, the phrase fills it, a lull thins it.
  let sp = spectrumAt(th - 0.2, th + 0.2);
  let lit = 0.45 + 0.75 * pow(sp, 0.85);
  let breath = 1.0 + 0.25 * U.bass;
  let fill = mix(0.6, 1.0, U.warpE.z) * mix(1.0, 0.45, U.lull);
  let depth = smoothstep(2.0, 16.0, d) * exp(-d / 150.0);
  let gain = 0.11 * veil * lit * breath * fill * depth * (1.0 + 0.9 * b2);

  let t = clamp(0.28 + 0.30 * veil + 0.12 * sp + 0.14 * hue, 0.0, 1.0);
  let accent = lightColour(0.94, 0.5);
  var col = coolPalette(t, U.mood) * gain;
  col += accent * (gain * 0.25 * smoothstep(0.6, 1.0, veil));

  // Black under it all, and the core.
  col += vec3f(0.0006, 0.0010, 0.0022);
  let vp = (U.warpF.xy - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let dist = length(unit - vp);
  let tint = latticeColour();
  col += tint * (0.006 + 0.03 * b2 + 0.004 * U.warpE.z) * exp(-dist * 2.2);
  // Hot and white at the centre, the accent at its fringe, swelling with
  // the burn - short of a white-out, which the bloom and the tonemap would
  // turn into a hard disc across the frame.
  let rad = 0.07 + 0.06 * U.warpE.z + 0.22 * b2;
  let g = exp(-(dist * dist) / (rad * rad));
  let hot = 0.05 + 0.07 * U.warpE.z + 0.7 * b2 + 0.2 * U.warpE.y * b2;
  col += vec3f(1.0, 0.97, 0.92) * (g * g * hot) + mix(tint, accent, 0.5) * (g * hot * 0.35);
  return vec4f(col, 1.0);
}

// -- lines: the rings and the rails -------------------------------------------

struct LineOut {
  @builtin(position) pos : vec4f,
  @location(0) x : f32,          // across the line, in sigmas
  @location(1) alpha : f32,
  @location(2) color : vec3f,
  @location(3) halo : f32,       // the halo's gain
};

fn hiddenLine() -> LineOut {
  var o : LineOut;
  o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  o.alpha = 0.0;
  return o;
}

/** Builds a strip vertex for a line through view point `p`, whose direction
 *  on screen is toward `pn`, extruded by `side` to a gaussian line of
 *  `sigmaWorld` units across - never under most of a pixel, and paid for in
 *  light when it is drawn wider than it is. */
fn lineVertex(p : vec3f, pn : vec3f, side : f32, sigmaWorld : f32,
              alpha : f32, color : vec3f, halo : f32) -> LineOut {
  let px = 2.0 / U.resolution.y;
  let pxScale = U.resolution.y / 1080.0;
  let c = projectW(p);
  let cn = projectW(pn);
  var t = cn - c;
  let tl = length(t);
  t = select(vec2f(1.0, 0.0), t / max(tl, 1e-6), tl > 1e-6);
  let perp = vec2f(-t.y, t.x);
  let sigmaTrue = sigmaWorld * PROJ_W * U.voyageZoom * U.resolution.y / (2.0 * max(p.z, 0.3));
  let sigmaDraw = max(sigmaTrue, 0.9 * pxScale);
  let rasterGain = sigmaTrue / sigmaDraw;
  let halfW = HALO * sigmaDraw * px;
  let unit = c + perp * (side * halfW);
  var o : LineOut;
  o.pos = clipAt(unit, p.z);
  o.x = side * HALO;
  o.alpha = alpha * rasterGain;
  o.color = color;
  o.halo = halo;
  return o;
}

/** The hoops: faint, wide circles of mist along the tunnel at no regular
 *  interval - each sits off its station by up to forty percent, a fifth
 *  are missing, every one its own brightness and size - lit softly by
 *  the spectrum at each point of their circumference, a quarter of them
 *  gates in the accent's colour. They dissolve before they reach the
 *  frame's edge: a hoop rushing past as a bar across the frame was the
 *  most intrusive thing in the piece. The lattice turns slowly and
 *  corkscrews along the travel. */
@vertex
fn ringVs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> LineOut {
  let sc = U.warpA.x;
  let m = floor((sc - 8.0) / RING_SPACING) + 1.0 + f32(ii);
  let mi = u32((i32(m) % i32(RINGS_PER_PERIOD) + i32(RINGS_PER_PERIOD)) % i32(RINGS_PER_PERIOD));
  let hr = hash3u(mi * 747796405u + 31u);
  let hr2 = hash3u(mi * 2654435761u + 37u);
  let s = (m + (hr.z - 0.5) * 0.8) * RING_SPACING;
  let d = s - sc;
  if (d < 4.0 || d > FAR || hr2.x < 0.3) { return hiddenLine(); }
  let gate = select(0.0, 1.0, hr2.y > 0.75);

  let j = vi / 2u;
  let side = f32(vi % 2u) * 2.0 - 1.0;
  let jj = j % SIDES;
  let arc = TAU / f32(SIDES);
  let theta = f32(jj) * arc + U.warpA.w + TWIST * s;
  let sp = spectrumAt(theta - 0.5 * arc, theta + 0.5 * arc);
  // Each hoop its own size; all of them breathe with the bass.
  let r = R * (1.0 + 0.06 * (hr.y - 0.5) + 0.04 * U.bass);
  let p = toView(tunnelPoint(d, vec2f(cos(theta), sin(theta)) * r));
  let pn = toView(tunnelPoint(d, vec2f(cos(theta + arc), sin(theta + arc)) * r));
  if (p.z < 0.5 || pn.z < 0.5) { return hiddenLine(); }

  // Light: the spectrum around the hoop, softly; the phrase; a touch of
  // the onset on the nearest; the waves. Far hoops thin to sub-pixel and
  // dim with it; the near dissolve before they fill the frame.
  let fog = (1.0 - smoothstep(FAR * 0.5, FAR, d)) / (1.0 + d / 110.0);
  let near = smoothstep(8.0, 24.0, d);
  let lit = 0.45 + 0.55 * pow(sp, 0.9);
  let phrase = 0.6 + 0.4 * U.warpE.z;
  let onset = 1.0 + U.onset * 0.25 * (1.0 - smoothstep(30.0, 120.0, d));
  let pulse = pulseAt(s);
  let boost = U.warpA.z;
  let quiet = mix(1.0, 0.55, U.lull);
  let own = mix(0.4, 1.0, hr.x) * (1.0 + gate * 0.8);
  let alpha = 0.11 * lit * phrase * onset * (1.0 + 0.5 * pulse) * own * fog * near * quiet
              * (1.0 + boost * 0.6);

  var col = latticeColour();
  let accent = lightColour(0.94, hr.y);
  col = mix(col, accent, gate * (0.75 + 0.25 * U.warpE.w));
  col = mix(col, vec3f(1.0, 0.96, 0.92), 0.15 * pow(sp, 1.5) + 0.3 * clamp(pulse, 0.0, 1.0));
  let sigma = 0.08 * (1.0 + gate * 0.5) * (1.0 + 0.3 * boost) * (0.85 + 0.3 * sp);
  return lineVertex(p, pn, side, sigma, alpha, col, 0.35);
}

/** Distance ahead of the camera for rail sample j: dense near, sparse far. */
fn railDist(j : u32) -> f32 {
  let u = f32(j) / f32(RAIL_SEGS);
  return 1.5 + (FAR - 1.5) * pow(u, 1.8);
}

/** The threads: faint lines the length of the tunnel, showing the bend
 *  and the corkscrew, with a slow flow of light running along them. */
@vertex
fn railVs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> LineOut {
  let nRails = u32(U.warpC.z);
  if (ii >= nRails) { return hiddenLine(); }
  let sc = U.warpA.x;
  let j = vi / 2u;
  let side = f32(vi % 2u) * 2.0 - 1.0;
  let d = railDist(j);
  let s = sc + d;
  let base = f32(ii) / f32(nRails) * TAU + U.warpA.w;
  let hr = hash3u(ii * 2654435761u + 41u);
  let theta = base + TWIST * s;
  let r = R * (1.0 + 0.05 * U.bass);
  let p = toView(tunnelPoint(d, vec2f(cos(theta), sin(theta)) * r));
  // The direction on screen, from the neighbouring sample ahead - behind,
  // for the last.
  let jn = select(j + 1u, j - 1u, j == RAIL_SEGS);
  let dn = railDist(jn);
  let thetaN = base + TWIST * (sc + dn);
  var pn = toView(tunnelPoint(dn, vec2f(cos(thetaN), sin(thetaN)) * r));
  if (p.z < 0.5) { return hiddenLine(); }
  if (jn < j) { pn = p + (p - pn); }

  let fog = (1.0 - smoothstep(FAR * 0.45, FAR * 0.95, d)) / (1.0 + d / 90.0);
  let near = smoothstep(2.0, 12.0, d);
  // The spectrum at the thread's angle, gently: the threads are long and
  // would otherwise flicker as a whole.
  let sp = spectrumAt(theta - 0.1, theta + 0.1);
  let lit = 0.5 + 0.5 * pow(sp, 0.9);
  // Light running toward the lens, one wave per beat when the tempo is
  // trusted, else at the mids' pace: a continuous flow, never a flash.
  let flow = 0.84 + 0.16 * sin(d * 0.12 + U.warpC.y + hr.x * TAU);
  let pulse = pulseAt(s);
  let boost = U.warpA.z;
  let phrase = 0.6 + 0.4 * U.warpE.z;
  let quiet = mix(1.0, 0.5, U.lull);
  let own = mix(0.45, 1.0, hr.y);
  let alpha = 0.11 * lit * flow * phrase * (1.0 + 0.6 * pulse) * own * fog * near * quiet
              * (1.0 + boost * 0.9);
  var col = latticeColour();
  col = mix(col, vec3f(1.0, 0.96, 0.92), 0.3 * clamp(pulse, 0.0, 1.0) + 0.2 * boost);
  let sigma = 0.03 * (1.0 + 0.3 * boost);
  return lineVertex(p, pn, side, sigma, alpha, col, 0.2);
}

@fragment
fn lineFs(in : LineOut) -> @location(0) vec4f {
  let x = in.x;
  let a = (exp(-0.5 * x * x) + in.halo * exp(-0.5 * x * x / 16.0))
          * (1.0 - smoothstep(HALO - 1.0, HALO, abs(x)));
  let light = a * in.alpha;
  if (light < 0.0002) { discard; }
  return vec4f(in.color * light, light);
}

// -- stars --------------------------------------------------------------------

struct StarOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,      // capsule-local, x along the streak, in body radii
  @location(1) halfLen : f32,      // streak half length, in body radii
  @location(2) color : vec3f,
  @location(3) alpha : f32,
};

fn hiddenStar() -> StarOut {
  var o : StarOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
  o.alpha = 0.0;
  return o;
}

/** The stars: inside the tube and far beyond it, wrapping in a window
 *  around the camera with the wrap folded into the hash. Each draws its
 *  own motion across the frame over a short shutter, so the streaks are
 *  the speed. */
@vertex
fn starVs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> StarOut {
  let count = u32(U.warpC.w);
  if (ii >= count) { return hiddenStar(); }
  let sc = U.warpA.x;
  let pxScale = U.resolution.y / 1080.0;
  let base = hash3u(ii * 2246822519u + 13u).x * STAR_WINDOW;
  let k = floor((sc - STAR_BACK - base) / STAR_WINDOW) + 1.0;
  let s = base + k * STAR_WINDOW;
  let wrap = u32(i32(k) + 64) % STAR_WRAPS;
  let key = ii + wrap * 65536u;
  let h = hash3u(key);
  let h2 = hash3u(key * 3266489917u + 1u);
  let h3 = hash3u(key * 668265263u + 2u);
  let d = s - sc;

  // Inside the tube, or in the space beyond its walls. The space is wide:
  // a field seen deeper than it is wide bunches into a knot at the
  // vanishing point, so the far stars are spread wider and faded by depth
  // before they can pile up there.
  let inside = h.x < 0.42;
  let r = select(R * (1.2 + 5.0 * pow(h.y, 0.7)), R * (0.10 + 0.84 * sqrt(h.y)), inside);
  let ang = h.z * TAU;
  let lat = vec2f(cos(ang), sin(ang)) * r;
  let p = toView(tunnelPoint(d, lat));
  if (p.z < 0.4) { return hiddenStar(); }
  let c = projectW(p);

  // Where it sat a shutter ago: further down the arc.
  let boost = U.warpA.z;
  let shutter = 0.07 + 0.05 * boost;
  let p0 = toView(tunnelPoint(d + U.warpA.y * shutter, lat));
  let c0 = projectW(p0);
  let deltaPx = (c - c0) * U.resolution.y * 0.5;
  let travel = length(deltaPx);
  let axis = select(vec2f(1.0, 0.0), deltaPx / max(travel, 1e-6), travel > 0.35);

  let sizeVary = exp2(0.3 * (2.0 * h2.x - 1.0));
  let radiusPx = clamp(0.9 + 22.0 / p.z, 0.9, 4.5) * pxScale * sizeVary;
  let maxStreak = (140.0 + 160.0 * boost) * pxScale;
  var halfLenPx = 0.5 * maxStreak * (1.0 - exp(-travel / maxStreak));
  if (halfLenPx < 0.35) { halfLenPx = 0.0; }
  // A streak spreads the light; a long exposure is allowed to gather some.
  let streakGain = pow((3.14159 * radiusPx * radiusPx)
                       / (3.14159 * radiusPx * radiusPx + 1.8 * radiusPx * halfLenPx), 0.45);

  // The dust inside the tube is for passing by: past a hundred units it
  // all projects into one small disc at the vanishing point, so it goes
  // long before the space outside does.
  let depthFade = select(1.0 - smoothstep(90.0, 220.0, p.z), 1.0 - smoothstep(35.0, 100.0, p.z), inside);
  let depthDim = inverseSqrt(1.0 + (p.z / 55.0) * (p.z / 55.0));
  let nearFade = smoothstep(0.4, 2.5, p.z);
  let brightVary = exp2(0.5 * (2.0 * h2.y - 1.0));
  // The highs sparkle the stars; a busy passage fills them in; a lull
  // thins them; the boost brightens them and the boost's own white-out
  // takes over past that.
  let music = (0.55 + 0.45 * clamp(U.high, 0.0, 1.2)) * mix(0.55, 1.0, U.musicDensity) * mix(1.0, 0.45, U.lull);
  let countGain = clamp(pow(12000.0 / f32(count), 0.4), 0.7, 1.7);
  let twinkle = 0.85 + 0.15 * sin(U.time * (0.8 + h3.z * 1.5) + h2.z * 40.0);
  let alpha = 0.55 * brightVary * music * twinkle * depthFade * depthDim * nearFade
              * streakGain * countGain * (1.0 + 0.8 * boost);
  if (alpha < 0.0004) { return hiddenStar(); }

  var color = vec3f(0.72, 0.84, 1.0);
  if (h3.x > 0.62) { color = lightColour(0.52, h3.y); }
  if (h3.x > 0.88) { color = lightColour(0.94, h3.y); }

  let px = 2.0 / U.resolution.y;
  let radius = radiusPx * px;
  let quad = radius * 1.5;
  let halfLen = halfLenPx * px;
  var corners = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let q = corners[vi];
  let perp = vec2f(-axis.y, axis.x);
  let off = axis * (q.x * (halfLen + quad)) + perp * (q.y * quad);
  let mid = c - axis * halfLen;
  let unit = mid + off;
  let pad = halfLen + quad;
  if (abs(mid.x) > U.aspect + pad || abs(mid.y) > 1.0 + pad) { return hiddenStar(); }
  var o : StarOut;
  o.pos = vec4f(unit.x / U.aspect, unit.y, 0.5, 1.0);
  o.local = vec2f(q.x * (halfLen + quad) / radius, q.y * quad / radius);
  o.halfLen = halfLen / radius;
  o.color = color;
  o.alpha = alpha;
  return o;
}

@fragment
fn starFs(in : StarOut) -> @location(0) vec4f {
  // The head is the star; behind it a tail narrows and fades toward where
  // it was a shutter ago.
  let L = in.halfLen;
  let x = in.local.x;
  let y = in.local.y;
  let rho = length(vec2f(x - L, y));
  let x0 = clamp(x, -L, L);
  let t = clamp((x0 + L) / max(2.0 * L, 1e-3), 0.0, 1.0);
  let hasTail = smoothstep(0.6, 3.0, L);
  let sigma = 0.22 + 0.30 * pow(t, 0.7);
  let tailD = length(vec2f(x - x0, y)) / sigma;
  let tail = (0.08 + 0.92 * pow(t, 1.5)) * exp(-0.5 * tailD * tailD) * hasTail;
  var a = exp(-0.5 * (rho / 0.5) * (rho / 0.5));
  a = 1.0 - (1.0 - a) * (1.0 - tail);
  a *= in.alpha;
  if (a < 0.0002) { discard; }
  return vec4f(in.color * a, a);
}
