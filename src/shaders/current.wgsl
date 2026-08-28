// Current: a fluid cosmic wave, made of strands, flown through.
//
// A sheet of silk runs along the flight path without end. Every eighty-odd
// units it rolls closed around the path - a full turn and a third, its
// radius tightening inward so the roll spirals into a hollow - and the
// hollow sits on the flight line, so the camera approaches it as a dark
// mouth ahead, passes through the roll with the strands wrapping past, and
// comes out to the next. Between rolls the sheet unrolls into a broad
// sweep that peels aside and flows past. A wider, dimmer echo of it runs
// far to one side, its rolls out of phase, for parallax.
//
// The sheet is drawn not as a surface but as its strands: a few hundred
// fine filaments, each at a fixed position across the sheet and following
// it along its whole length, banded and gapped like the rings of Saturn.
// Where the sheet turns edge-on the strands pile up on screen and the
// light gathers on the fold; where it faces the eye it is a striated silk.
// Light lives in the contours.
//
// Everything is periodic in the path, on integer harmonics of the flight's
// period, so the travel never wraps visibly; the form also evolves on slow
// clocks of its own. The camera is the flight's: the path, the breathing
// speed and the gaze sweeps of the voyage, banking into the bends.

const SEGS : u32 = 224u;
const HALO : f32 = 11.0;  // strip half-width in sigmas: the line, and a halo about it
const PI : f32 = 3.14159265359;
const BEHIND : f32 = 14.0;    // drawn from this far behind the camera...
const AHEAD : f32 = 210.0;    // ...to this far ahead
const ROLL_L : f32 = PERIOD / 120.0;   // a roll every hundred units
const ROLL_SIGMA : f32 = 9.0;          // how far along the path a roll reaches

// -- the sheets ---------------------------------------------------------------

struct Sheet {
  lateral : f32,      // how far the sheet's spine sits from the flight line between rolls
  side : f32,         // which way it sits (an angle about the path)
  scale : f32,
  rollShift : f32,    // its rolls, in fractions of ROLL_L, off the hero's
  rollGain : f32,     // how far its rolls close (1 = a full roll)
  onLine : f32,       // 1: its rolls close around the flight line
  gain : f32,
  seed : f32,
};

/** The hero, whose rolls close around the flight line; an echo far to one
 *  side, wider and dimmer, its rolls between the hero's; and a veil,
 *  further out on the other side, only when the music is full. */
fn sheetAt(h : u32) -> Sheet {
  var sh : Sheet;
  if (h == 0u) {
    sh.lateral = 17.0;  sh.side = 0.0;  sh.scale = 1.0;
    sh.rollShift = 0.0;  sh.rollGain = 1.0;  sh.onLine = 1.0;
    sh.gain = 1.0;  sh.seed = 0.13;
  } else if (h == 1u) {
    sh.lateral = 40.0;  sh.side = 2.4;  sh.scale = 2.0;
    sh.rollShift = 0.5;  sh.rollGain = 0.45;  sh.onLine = 0.0;
    sh.gain = U.sculptD.z;  sh.seed = 0.61;
  } else {
    sh.lateral = 55.0;  sh.side = -1.5;  sh.scale = 1.6;
    sh.rollShift = 0.25;  sh.rollGain = 0.2;  sh.onLine = 0.0;
    sh.gain = U.sculptD.w;  sh.seed = 0.87;
  }
  return sh;
}

/** Slow clocks: one cycle per `period` seconds of the evolution time. */
fn cyc(period : f32, phase : f32) -> f32 {
  return sin(U.sculptB.y * (TAU / period) + phase);
}

/** How far station k closes, 0..1: decided by the CPU from the music as
 *  the station came into view, for the six stations in view. */
fn closureOf(k : f32) -> f32 {
  let i = i32(k - U.sculptF.y);
  if (i <= 0) { return U.sculptF.z; }
  if (i == 1) { return U.sculptF.w; }
  if (i == 2) { return U.sculptG.x; }
  if (i == 3) { return U.sculptG.y; }
  if (i == 4) { return U.sculptG.z; }
  return U.sculptG.w;
}

struct Roll { centre : f32, amount : f32, sigma : f32, chirality : f32, offset : vec2f, k : f32 };

/** The nearest roll along the path: its centre, how far this point is
 *  inside it (0..1), and its character. Roll k sits near k * ROLL_L, but
 *  each is its own: shifted by up to a third of the spacing, reaching
 *  seven to sixteen units, turning one way or the other, its centre a few
 *  units off the line, one in seven left out; and it closes as much as
 *  the music asked as it came near. The hashes are of k modulo the rolls
 *  in a period, so the pattern repeats with the path. */
fn rollAt(sh : Sheet, s : f32) -> Roll {
  var r : Roll;
  let x = s / ROLL_L - sh.rollShift;
  let k = floor(x + 0.5);
  let ki = u32(i32(k) + 120 * 4) % 120u;
  let h = hash3u(ki * 747796405u + 19u);
  let h2 = hash3u(ki * 2654435761u + 23u);
  let jitter = (h.x - 0.5) * 0.66 + 0.05 * cyc(97.0, sh.seed);
  r.k = k;
  r.centre = (k + sh.rollShift + jitter) * ROLL_L;
  r.sigma = 7.0 + 5.0 * h.y;
  r.chirality = select(-1.0, 1.0, h.z < 0.5);
  // Off the line by a unit or so at most: the hollow is under three units
  // across, and a pass through the sheet's layers instead is a tangle.
  r.offset = vec2f(h2.x - 0.5, h2.y - 0.5) * 2.4;
  let present = step(0.14, h2.z);
  let u = (s - r.centre) / r.sigma;
  r.amount = exp(-0.5 * u * u) * closureOf(k) * present;
  return r;
}

/** The spine of sheet h at s: the path, plus a lateral offset that turns
 *  slowly about it and, for the hero, closes to nothing inside a roll, so
 *  the hollow lies on the flight line and the camera passes through it. */
fn spineAt(sh : Sheet, s : f32) -> vec3f {
  let f = frameAt(s);
  let rl = rollAt(sh, s);
  let roll = rl.amount;
  let psi = sh.side + s * (K * 24.0) + 0.35 * cyc(131.0, sh.seed) + 0.5 * sin(s * (K * 61.0) + sh.seed * 3.0);
  let away = sh.lateral * mix(1.0, 1.0 - 0.93 * roll, sh.onLine) * (1.0 + 0.25 * sin(s * (K * 85.0) + sh.seed * 6.0));
  let lift = 4.0 * sin(s * (K * 60.0) + 1.7 + sh.seed) * mix(1.0, 1.0 - roll, sh.onLine);
  // A roll's own eccentricity: its centre sits a few units off the line.
  let ecc = rl.offset * roll * sh.onLine;
  return pathAt(s) + f.n * (away * cos(psi) + ecc.x) + f.b * (away * sin(psi) * 0.7 + lift + ecc.y);
}

/** The pulses: light and a bulge travelling away down the sheet from the
 *  camera - the beats' and the onsets' - and an instrument's entrance as a
 *  broader one. Positions are in path units and wrap with the period. */
fn pulseAt(s : f32) -> f32 {
  var d1 = s - U.sculptC.x;  d1 -= PERIOD * round(d1 / PERIOD);
  var d2 = s - U.sculptC.z;  d2 -= PERIOD * round(d2 / PERIOD);
  var d3 = s - U.sculptD.x;  d3 -= PERIOD * round(d3 / PERIOD);
  var d4 = s - U.sculptE.z;  d4 -= PERIOD * round(d4 / PERIOD);
  d1 /= 6.0;  d2 /= 6.0;  d3 /= 6.0;  d4 /= 9.0;
  let sum = U.sculptC.y * exp(-0.5 * d1 * d1) + U.sculptC.w * exp(-0.5 * d2 * d2)
          + U.sculptD.y * exp(-0.5 * d3 * d3) + U.sculptE.w * exp(-0.5 * d4 * d4);
  return 1.05 * tanh(sum / 1.05);
}

/** How far around the spine the sheet wraps at s: a full turn and a third
 *  in a roll, deepening with the bass and relaxing in a lull, easing to a
 *  shallow arc along the sweep. */
fn wrapAt(sh : Sheet, roll : f32) -> f32 {
  let evolve = 1.0 + (0.14 * cyc(61.0, 0.0) + 0.06 * cyc(103.0, 1.0)) / 2.0;
  let music = 0.28 * U.sculptA.x - 0.08 * U.sculptA.z;
  return PI * (0.55 + (1.85 * evolve + music) * sh.rollGain * roll);
}

/** The roll's outer radius: fuller in a roll, swelling and thinning along
 *  the path, breathing with the bass, opening in a lull, bulging under a
 *  pulse. */
fn radiusAt(sh : Sheet, s : f32, roll : f32) -> f32 {
  let evolve = 1.0 + 0.07 * cyc(47.0, 0.0) + 0.04 * cyc(109.0, 1.0);
  return 7.2 * sh.scale * (1.0 + 0.30 * roll + 0.12 * sin(s * (K * 96.0) + sh.seed * 9.0)) * evolve
       * (1.0 + 0.10 * U.sculptA.x + 0.05 * U.sculptA.z + 0.16 * pulseAt(s));
}

/** A point of the sheet: along the path at s, across it at w (0 the outer
 *  lip .. 1 the inner lip, on the hollow). The cross-section is a spiral
 *  around the spine, with a living fold in it: a hint of a wave across the
 *  width in a roll, and a ripple in the radius, both under three percent. */
fn sheetPoint(sh : Sheet, s : f32, w : f32) -> vec3f {
  let p = spineAt(sh, s);
  let t = normalize(spineAt(sh, s + 0.5) - spineAt(sh, s - 0.5));
  let n = normalize(cross(vec3f(0.0, 1.0, 0.0), t));
  let b = cross(t, n);
  let rc = rollAt(sh, s);
  let roll = rc.amount;
  let helix = 0.06 * (s - rc.centre) * roll * rc.chirality;
  let phi0 = s * (K * 40.0) + PI * (0.10 * cyc(79.0, 0.0)) + sh.side + helix;
  let bend = PI * (0.06 * roll * sin(TAU * w - s * 0.1) + 0.04 * U.sculptA.y * pulseAt(s) * sin(TAU * w));
  let phi = phi0 + w * wrapAt(sh, roll) + bend;
  let kappa = 0.82 + 0.38 * roll;
  let r = radiusAt(sh, s, roll) * exp(-kappa * w) * (1.0 + 0.025 * sin(4.0 * PI * w + s * 0.085));
  return p + (n * cos(phi) + b * sin(phi)) * r;
}

/** Distance ahead of the camera for sample j: a stretch behind, most of
 *  it ahead, dense at zero. */
fn distanceAt(j : u32) -> f32 {
  let u = f32(j) / f32(SEGS) * 1.25 - 0.25;
  if (u < 0.0) { return -BEHIND * pow(-u / 0.25, 1.6); }
  return AHEAD * pow(u, 1.6);
}

// -- the camera ---------------------------------------------------------------

/** A point's place on screen, in pixels from the centre. */
fn screenPx(v : vec3f, proj : f32) -> vec2f {
  return v.xy * (proj / max(v.z, 0.3)) * (U.resolution.y * 0.5);
}

// -- colour -------------------------------------------------------------------

/** Cobalt at the outer lip, through blue to a dusty violet inward and dark
 *  violet at the inner lip. Linear light. */
fn silk(w : f32) -> vec3f {
  let c0 = vec3f(0.045, 0.18, 0.62);
  let c1 = vec3f(0.09, 0.28, 0.68);
  let c2 = vec3f(0.18, 0.42, 0.76);
  let c3 = vec3f(0.31, 0.47, 0.82);
  let c4 = vec3f(0.36, 0.30, 0.66);
  let c5 = vec3f(0.24, 0.18, 0.46);
  var c = mix(c0, c1, smoothstep(0.0, 0.35, w));
  c = mix(c, c2, smoothstep(0.35, 0.55, w));
  c = mix(c, c3, smoothstep(0.55, 0.72, w));
  c = mix(c, c4, smoothstep(0.72, 0.90, w));
  return mix(c, c5, smoothstep(0.90, 1.0, w));
}

// -- backdrop -----------------------------------------------------------------

/** Black above, an indigo so deep it is barely there below, fixed in the
 *  world so it turns with the flight. No stars, no dust, no haze. Drawn
 *  by the resolve, under the strands. */
fn backdrop(uv : vec2f) -> vec3f {
  let cam = cameraAt(U.voyageZ, 0.0);
  let unit = (uv - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let dir = viewToDir(normalize(vec3f(unit / cam.proj, 1.0)), cam);
  let low = 1.0 - smoothstep(-0.7, 0.5, dir.y);
  var col = vec3f(0.0003, 0.0007, 0.0022);
  col += vec3f(0.0010, 0.0026, 0.0075) * low;
  return col * mix(1.0, 0.7, U.sculptA.z);
}

// -- strands ------------------------------------------------------------------

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) x : f32,          // across the strand, in sigmas
  @location(1) alpha : f32,
  @location(2) color : vec3f,
  @location(3) s : f32,          // along the sheet
  @location(4) @interpolate(flat) seed : f32,
  @location(5) contour : f32,    // 1 where the sheet is edge-on to the eye
  @location(6) halo : vec2f,     // the halo's sigma, in sigmas of the line, and its amplitude
};

fn hidden() -> VSOut {
  var o : VSOut;
  o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  o.alpha = 0.0;
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  let N = max(u32(U.sculptB.z), 1u);
  let H = u32(U.sculptB.w);
  let h = ii / N;
  let k = ii % N;
  if (h >= H) { return hidden(); }
  let sh = sheetAt(h);
  if (sh.gain < 0.003) { return hidden(); }
  let hk = hash3u(ii * 2246822519u + 77u);
  let hk2 = hash3u(ii * 3266489917u + 78u);
  // Stratified across the sheet, jittered so no two strands keep a fixed
  // spacing along their whole length.
  let w = (f32(k) + 0.5 + (hk.x - 0.5) * 0.7) / f32(N);
  let j = vi / 2u;
  let side = f32(vi % 2u) * 2.0 - 1.0;
  let z = U.voyageZ;
  let d = distanceAt(j);
  let s = z + d;
  let cam = cameraAt(z, 0.0);
  let proj = cam.proj;

  // Neighbours over a fixed baseline, not the sample spacing: near the
  // camera the samples are a fiftieth of a unit apart, which at path
  // coordinates in the thousands is inside float precision.
  let p = sheetPoint(sh, s, w);
  let pPrev = sheetPoint(sh, s - 0.5, w);
  let pNext = sheetPoint(sh, s + 0.5, w);
  let pAcross = sheetPoint(sh, s, w + 0.02);
  let normal = normalize(cross(pNext - pPrev, pAcross - p));

  let camPos = cam.pos;
  let v = dirToView(p - camPos, cam);
  let zNeighbours = min(dirToView(pPrev - camPos, cam).z, dirToView(pNext - camPos, cam).z);
  let nearClip = smoothstep(NEAR_CLIP, NEAR_CLIP + 1.0, zNeighbours);
  let eye = normalize(p - camPos);
  let face = abs(dot(normal, eye));
  let g = 1.0 - face;
  // The far wall of the roll - the side of the spine away from the eye,
  // seen through the near wall - is dimmer: silk seen through silk. The
  // sheet's normal cannot tell the walls apart, since which of its two
  // sides faces the eye differs between the roll and the sweep.
  let wall = mix(1.0, 0.28, smoothstep(-1.5, 1.5, dot(p - spineAt(sh, s), eye)));
  let dist = length(p - camPos);

  // A line, a gaussian sigma wide on screen and never under most of a
  // pixel, extruded in view space by the world width that projects to
  // that, so a vertex beside the lens offsets by almost nothing and is
  // clipped cleanly. True clip depth throughout. The extrusion direction
  // is taken in the world - perpendicular to both the strand and the eye
  // ray - which is continuous along the strand; a perpendicular of the
  // projected tangent flipped where the strand hairpinned on screen, the
  // strip folded over itself, and every join showed as a bead. Where the
  // strand runs straight at the lens the sheet's own across direction
  // stands in.
  let px = 2.0 / U.resolution.y;
  let pxScale = U.resolution.y / 1080.0;
  let along = pNext - pPrev;
  var side3 = cross(along, eye);
  let across3 = cross(pAcross - p, eye);
  let endOn = smoothstep(0.0, 0.05, length(side3) / max(length(along), 1e-6));
  side3 = normalize(mix(normalize(across3 + vec3f(1e-5, 0.0, 0.0)), normalize(side3 + vec3f(1e-6, 0.0, 0.0)), endOn));
  let perp = dirToView(side3, cam);
  // Coverage of a stretch foreshortened to under a couple of pixels is
  // scaled down with it: a strand seen end-on would otherwise gather its
  // light into a point, and along the limb of the roll, where every lip
  // strand turns end-on, those points lined up as a row of beads. The
  // chord of this segment on screen is the baseline's, scaled to the
  // actual sample spacing.
  let dsHere = distanceAt(min(j + 1u, SEGS)) - distanceAt(max(j, 1u) - 1u);
  let here = screenPx(v, proj);
  let chordBase = length(screenPx(dirToView(pNext - camPos, cam), proj) - screenPx(dirToView(pPrev - camPos, cam), proj));
  let chord = chordBase * (0.5 * dsHere);
  let foreshort = clamp(chord / (2.0 * pxScale), 0.05, 1.0);
  let zc = max(v.z, 0.3);
  let widthWorld = 0.024 * mix(0.85 + 0.3 * hk.y, 1.0, 0.9 * g * g);
  let sigmaTrue = widthWorld * proj * U.resolution.y / (2.0 * zc);
  let sigmaDraw = max(sigmaTrue, 1.0 * pxScale);
  let rasterGain = sigmaTrue / sigmaDraw * foreshort;
  let halfW = HALO * sigmaDraw * px * max(v.z, 0.02) / proj;
  let vo = v + perp * (side * halfW);
  // The sheet is a luminous surface, not a set of lines of constant
  // screen brightness: as it comes close its strands spread apart and the
  // body between them went dark. The halo about each strand widens with
  // the projected spacing of the strands and carries more light, so the
  // surface keeps its brightness and stays continuous, while the line
  // itself keeps the striation.
  let spacingPx = length(pAcross - p) / (0.02 * f32(N)) * proj * U.resolution.y / (2.0 * zc);
  let haloSigma = clamp(0.7 * spacingPx / sigmaDraw, 3.0, 8.0);
  let bodyGain = clamp(spacingPx / (3.5 * pxScale), 0.6, 1.8);

  // -- light ------------------------------------------------------------
  // The rings. Three families across the sheet, each bending along it
  // and drifting at its own slow pace: broad folds, the filaments that
  // pick out which strands shine, and a fine ripple the highs bring up.
  // Two thin gaps divide the bands, as Cassini's does. Along the path
  // every frequency is an integer harmonic of the period.
  let E = U.sculptB.y;
  let roll = rollAt(sh, s).amount;
  let folds = 1.0 + 0.08 * sin(TAU * 6.5 * w + s * (K * 80.0) + E * 0.113 + hk2.x * 2.0);
  let filaments = pow(0.5 + 0.5 * cos(TAU * 27.0 * w - s * (K * 137.0) + E * 0.346 + hk2.y * 1.5), 8.0);
  let fine = pow(0.5 + 0.5 * cos(TAU * 35.0 * w + s * (K * 27.0) + E * 0.817 + hk.z * 2.0), 16.0);
  let g1 = 0.30 + 0.04 * cyc(97.0, sh.seed);
  let g2 = 0.66 + 0.04 * cyc(131.0, 2.0 + sh.seed);
  let gaps = (1.0 - 0.55 * exp(-((w - g1) / 0.028) * ((w - g1) / 0.028)))
           * (1.0 - 0.55 * exp(-((w - g2) / 0.028) * ((w - g2) / 0.028)));
  // The outer lip carries more light, over a band of strands.
  let lip = 1.0 + 0.70 * exp(-(w / 0.09) * (w / 0.09));
  // The innermost strands fade where the sheet is rolled: the inner lip's
  // end read as a pinched hook.
  let lipEnd = 1.0 - 0.85 * smoothstep(0.60, 0.92, w) * roll;
  var rings = (0.62 + 0.27 * filaments + (0.06 + 0.18 * U.sculptF.x) * fine) * folds * gaps * lip * lipEnd;
  // Along a limb, where the sheet turns edge-on and its strands stack, the
  // bright strands of the filament family stood out as a dotted zipper:
  // the pattern flattens there and the limb reads as one line.
  rings = mix(rings, 0.78 * folds * gaps * lip * lipEnd, 0.75 * g * g);
  // Every strand its own brightness; the faint half fills in as the music
  // fills.
  var own = mix(0.55, 1.0, hk.z) * mix(mix(0.35, 1.0, U.sculptA.y), 1.0, step(0.5, hk2.z));
  own = mix(own, 0.8, 0.75 * g * g);
  // Along the path: a texture of light flowing along every strand at the
  // music's pace, five units to the wave, and the pulses running ahead.
  // In the camera's coordinates, not the path's: measured along the path
  // the wave was carried by the flight and stalled, reversed or raced with
  // the speed. Here it runs toward the lens at its own pace - one wave per
  // beat while the tempo is trusted - however fast the flight.
  let flow = 0.84 + 0.16 * sin(d * 1.257 + U.sculptB.x + hk.y * TAU);
  let pulse = pulseAt(s);
  // Edge-on gathers the strands into a line of light on its own; the sheen
  // adds only a little, so the body stays a dim striated silk.
  let sheen = 0.68 + 0.32 * pow(g, 3.0);
  // Fog by depth, far enough out that the next roll shows as the mouth
  // ahead; what lies behind the lens fades before the strip ends.
  let fog = 1.0 - exp(-max(v.z, 0.0) / 150.0);
  // The strip ends far ahead and a little behind: both ends dissolve, or
  // every strand's last segment lines up as a comb.
  let behind = smoothstep(-BEHIND, -BEHIND + 6.0, d) * (1.0 - smoothstep(AHEAD - 55.0, AHEAD - 4.0, d));
  // A sheet passing beside the lens is clipped at the near plane through
  // the middle of its triangles, a sawtooth: it fades by view depth first.
  // The nearest wall of a roll, crossing the lens, dims by view depth as
  // well: at full light it read as a flat grille across the frame.
  let nearFade = smoothstep(1.0, 4.5, dist) * nearClip * mix(0.35, 1.0, smoothstep(2.5, 12.0, v.z));
  let peak = 0.42 * (160.0 / f32(N)) * sh.gain;
  let intensity = U.sculptE.x;
  let alpha = peak * rings * own * flow * (1.0 + 0.8 * pulse)
            * sheen * wall * (1.0 - 0.75 * fog) * behind * nearFade * rasterGain * intensity;

  // -- colour -----------------------------------------------------------
  // Peach on the middle of the rolled sheet, cooling toward the inner lip,
  // and mostly on its underside - the light caught inside the curl - more
  // of it, and further across the sheet, as the music warms. A whisper of
  // hue per strand; the far sinks into midnight.
  let warmOn = mix(0.64, 0.38, U.sculptA.w);
  let warmMask = clamp(roll * smoothstep(warmOn, 0.80, w) * (1.0 - smoothstep(0.80, 0.92, w))
                     + 0.12 * (1.0 - roll) * smoothstep(0.72, 0.94, w), 0.0, 1.0);
  let underside = mix(0.35, 1.0, 1.0 - smoothstep(-0.55, 0.1, normal.y));
  let warm = clamp(warmMask * underside * (0.18 + 1.5 * U.sculptE.y), 0.0, 1.0) * select(0.0, 1.0, h == 0u);
  let coral = vec3f(0.78, 0.30, 0.07);
  let peach = vec3f(1.00, 0.58, 0.13);
  var col = silk(w);
  col = mix(col, col.zxy, (hk2.y - 0.5) * 0.05);
  col = mix(col, mix(coral, peach, warmMask), warm);
  col = mix(col, vec3f(0.04, 0.06, 0.22), fog * 0.6);
  col = mix(col, vec3f(0.85, 0.85, 1.0), 0.3 * clamp(pulse, 0.0, 1.0));

  var o : VSOut;
  o.pos = vec4f(vo.x * proj / U.aspect, vo.y * proj, depthOf(vo.z) * vo.z, vo.z);
  o.x = side * HALO;
  o.alpha = alpha;
  o.color = col;
  o.s = s;
  o.seed = hk.x;
  o.contour = g;
  o.halo = vec2f(haloSigma, 0.11 * bodyGain);
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // The line, and a halo a third as bright spread over three times its
  // width: silk between the strands, without bloom.
  let x = in.x;
  let hs = in.halo.x;
  let a = (exp(-0.5 * x * x) + in.halo.y * exp(-0.5 * x * x / (hs * hs))) * (1.0 - smoothstep(HALO - 1.0, HALO, abs(x)));
  // The highs: fine glints on the contours only, drifting slowly - fixed
  // in the world at a long wavelength, so the flight moves them under a
  // hertz rather than strobing them.
  let gl = 0.5 + 0.5 * sin(in.s * 0.35 + in.seed * 40.0 + U.time * 1.2);
  let shimmer = U.sculptF.x * 0.25 * pow(in.contour, 7.0) * pow(gl, 4.0);
  let light = a * in.alpha * (1.0 + shimmer);
  let col = mix(in.color, vec3f(1.0, 0.63, 0.50), 0.5 * shimmer);
  if (light < 0.0002) { discard; }
  return vec4f(col * light, light);
}

// -- resolve ------------------------------------------------------------------

@group(0) @binding(2) var strands : texture_2d<f32>;

// Optical thickness per unit of accumulated strand light. Small, so a lone
// strand passes almost unchanged and only a pile-up saturates.
const THICKNESS : f32 = 0.75;

/** The strands accumulate radiance and thickness in a target of their own;
 *  here they become silk: where they pile up the light saturates toward the
 *  strands' own colour instead of summing on toward white, and a lone strand
 *  is left alone. Over the backdrop, in one pass. */
@fragment
fn resolveFs(in : FullOut) -> @location(0) vec4f {
  let acc = textureLoad(strands, vec2i(in.pos.xy), 0);
  let tau = acc.a * THICKNESS;
  let f = (1.0 - exp(-tau)) / max(tau, 1e-4);
  return vec4f(backdrop(in.uv) + acc.rgb * f, 1.0);
}
