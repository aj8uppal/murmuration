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

const WINDOW : f32 = 96.0;    // how much of the path holds lights at once
const BACK   : f32 = 6.0;     // of which, how much lies behind the camera
const WRAPS  : f32 = PERIOD / WINDOW;

// Quads are drawn wider than the optical body, to hold the halo.
const DISC_QUAD  : f32 = 2.0;
const POINT_QUAD : f32 = 1.5;

// The trail's exposure, in seconds.
const SHUTTER : f32 = 0.12;

/** A lantern's warmth: amber against whatever the mood makes of the field.
 *  Without it a cold bank leaves the flight grey, and a lo-fi night is never
 *  without a warm light somewhere. */
fn lanternColour(pick : f32, jitter : f32) -> vec3f {
  // Deep amber: a paler one comes out of the ACES shoulder as cream.
  let amber = vec3f(1.0, 0.56, 0.22) * (0.9 + jitter * 0.2);
  // The voice gathers the cool lanterns onto one hue - the accent - so a
  // sung phrase is a change of colour, not just of brightness. A real mix
  // of the colours: moving the pick across the anchors read as scattered
  // hue changes rather than one coherent shift.
  let cool = mix(lightColour(pick, jitter), lightColour(0.97, jitter), U.voicePresence * 0.8);
  return select(cool, mix(cool, amber, 0.90), pick > 0.75);
}

// -- backdrop -----------------------------------------------------------------

/** Black. A whisper of the mood, off centre and fixed in the world so it
 *  slides as the flight turns, is all that keeps it from being a void. */
@fragment
fn bgFs(in : FullOut) -> @location(0) vec4f {
  let cam = cameraAt(U.voyageZ, 0.0);
  let unit = (in.uv - 0.5) * vec2f(2.0 * U.aspect, -2.0);
  let dir = viewToDir(normalize(vec3f(unit / cam.proj, 1.0)), cam);
  let g = smoothstep(-0.65, 0.80, dot(dir, normalize(vec3f(-0.55, 0.32, 0.77))));
  var col = vec3f(0.0006, 0.0009, 0.0018);
  col += coolPalette(0.15, U.mood) * 0.008 * (0.4 + 0.6 * g);
  return vec4f(col, 1.0);
}

// -- lights -------------------------------------------------------------------

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) local    : vec2f,   // capsule-local, x along the streak, in body radii
  @location(1) halfLen  : f32,     // streak half length, in body radii
  @location(2) color    : vec3f,
  @location(3) alpha    : f32,
  @location(4) radiusPx : f32,     // the optical body, in pixels
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

/** Builds the sprite once its screen placement is known. `centre` and `axis`
 *  are in unit space; `radiusPx` and `halfLenPx` are in pixels. */
fn sprite(vi : u32, centre : vec2f, axis : vec2f, radiusPx : f32, halfLenPx : f32,
          color : vec3f, alpha : f32, kind : f32, rim : f32, depth : f32) -> VSOut {
  let px = 2.0 / U.resolution.y;
  let radius = radiusPx * px;
  let quad = radius * select(POINT_QUAD, DISC_QUAD, kind > 0.5);
  let halfLen = halfLenPx * px;
  let q = quadCorner(vi);
  let perp = vec2f(-axis.y, axis.x);
  let off = axis * (q.x * (halfLen + quad)) + perp * (q.y * quad);
  // The head of the trail is where the light is now, so the quad sits
  // behind it: its midpoint is half a trail back along the motion.
  let mid = centre - axis * halfLen;
  let unit = mid + off;
  let pad = halfLen + quad;
  if (abs(mid.x) > U.aspect + pad || abs(mid.y) > 1.0 + pad) { return hidden(); }
  var o : VSOut;
  o.pos = vec4f(unit.x / U.aspect, unit.y, clamp(depth, 0.0, 1.0), 1.0);
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
  let cam = cameraAt(U.voyageZ, 0.0);
  let pxScale = U.resolution.y / 1080.0;   // lens constants are stated at 1080p
  let skyCount = u32(U.voyageB.z);
  let pathCount = u32(U.voyageB.w);
  // No seed here, deliberately: R reseeds the particle field, and a flight
  // that re-rolled every light at once would pop. Variety comes from where
  // along the period the flight began.

  // -- the sky: at infinity, so only the turn moves it ----------------------
  if (ii < skyCount) {
    let h = hash3u(ii * 2654435761u);
    let h2 = hash3u(ii * 40503u + 7u);
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
    let alpha = (0.15 + mag * 1.10) * twinkle * quiet * (0.85 + U.high * 0.25);
    return sprite(vi, centre, vec2f(1.0, 0.0), radiusPx, 0.0, color, alpha, 0.0, 0.0, 1.0);
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
  let key = i + wrap * 65536u;
  let h = hash3u(key);
  let h2 = hash3u(key * 3266489917u + 1u);
  let h3 = hash3u(key * 668265263u + 2u);
  let h4 = hash3u(key * 374761393u + 3u);

  // Dust is texture; the lanterns carry the flight. Too much dust and the
  // whole thing reads as a particle system again, so a fifth of the
  // instances are simply not drawn rather than spent on more of it.
  let dustCount = u32(f32(pathCount) * 0.42);
  let lanternCount = u32(f32(pathCount) * 0.35);
  let heroCount = u32(f32(pathCount) * 0.03);
  if (i >= dustCount + lanternCount + heroCount) { return hidden(); }
  var population = 0u;
  if (i >= dustCount + lanternCount) { population = 2u; }
  else if (i >= dustCount) { population = 1u; }

  // Each population fills a flat disc and is faded out by view depth before
  // its projection can contract into a knot at the vanishing point. The disc
  // has a soft rim, or the cylinder's wall shows. Heroes are the near-pass
  // population, so their field is narrow and short. Lens constants are in
  // pixels at 1080p; peaks are HDR.
  var discR = 52.0; var z0 = 55.0; var z1 = 78.0;
  var aperture = 1.0; var rDiff = 0.75; var geom = 4.5; var rClampMin = 0.8; var rClampMax = 9.0;
  var maxStreak = 110.0; var rRef = 1.4; var peak = 0.45; var kind = 0.0; var rim = 0.0;
  if (population == 1u) {
    // Lanterns are the point of the flight: bodies of light that pass and
    // bloom as they come close, drawing the longest wakes.
    discR = 34.0; z0 = 36.0; z1 = 54.0;
    aperture = 4.6; rDiff = 0.90; geom = 16.0; rClampMin = 1.15; rClampMax = 64.0;
    maxStreak = 300.0; rRef = 3.0; peak = 1.70; kind = 1.0; rim = 0.10;
  }
  if (population == 2u) {
    discR = 10.0; z0 = 16.0; z1 = 26.0;
    aperture = 6.6; rDiff = 1.10; geom = 24.0; rClampMin = 1.4; rClampMax = 96.0;
    maxStreak = 140.0; rRef = 4.5; peak = 2.30; kind = 2.0; rim = 0.18;
  }
  aperture *= U.voyageB.y;
  // Size and brightness vary independently, and a bigger light is not also a
  // brighter one - that pairing made the same few "important dots" recur.
  let sizeVary = exp2(0.28 * (2.0 * h4.x - 1.0));
  let brightVary = exp2(0.35 * (2.0 * h4.y - 1.0)) * pow(sizeVary, -0.45);

  let r = discR * sqrt(h.x);
  let ang = h.y * TAU;
  let lateral = vec2f(cos(ang), sin(ang)) * r;
  let taper = 1.0 - smoothstep(0.88 * discR, discR, r);
  let collide = smoothstep(0.15, 0.55, r);

  let f = frameAt(s);
  let world = pathAt(s) + f.n * lateral.x + f.b * lateral.y;
  let v = dirToView(world - cam.pos, cam);
  if (v.z < 0.05) { return hidden(); }
  let zv = v.z;
  let centre = project(v, cam.proj);

  // Where the same light sat a shutter ago. Only the camera moved, and
  // turned. The shutter is long: the trail is the point of the flight.
  let cam0 = cameraAt(z - U.voyageA.x * SHUTTER, SHUTTER);
  let v0 = dirToView(world - cam0.pos, cam0);
  let centre0 = project(v0, cam.proj);
  let deltaPx = (centre - centre0) * U.resolution.y * 0.5;
  let travel = length(deltaPx);
  let axis = select(vec2f(1.0, 0.0), deltaPx / max(travel, 1e-6), travel > 0.35);

  // The lens. A thin-lens circle of confusion in pixels, on top of a core that
  // is the light's own size until diffraction wins.
  let focus = U.voyageB.x;
  let coc = aperture * abs(focus / zv - 1.0) * pxScale;
  let core = sqrt(rDiff * rDiff * pxScale * pxScale + (geom * pxScale / zv) * (geom * pxScale / zv));
  // The beat swells every lantern and hero together, briefly; a chorus
  // holds them larger for as long as it lasts; the heroes also breathe with
  // the pulse the tempo tracker has locked to. All in size, none in the
  // camera.
  let beatSwell = U.beat * exp(-U.beatAge * 5.5) * 0.12;
  var breathe = 1.0;
  if (population > 0u) { breathe = 1.0 + beatSwell + U.voyageC.w * 0.25; }
  if (population == 2u) { breathe += U.phasePulse * 0.08; }
  let radiusPx = clamp(sqrt(core * core + coc * coc), rClampMin * pxScale, rClampMax * pxScale)
                 * sizeVary * breathe;
  // Never below a pixel: shimmer. Pay for it in energy instead.
  let drawnPx = max(radiusPx, 0.9);
  let rasterGain = (radiusPx * radiusPx) / (drawnPx * drawnPx);

  // The trail: the light's own motion across the frame over the shutter,
  // soft-limited so a near pass never becomes a bar across the screen, and
  // shorter on big discs, which motion would only smear.
  var halfLenPx = 0.5 * maxStreak * (1.0 - exp(-travel / maxStreak));
  halfLenPx *= clamp(6.0 / drawnPx, 0.3, 1.0);
  if (halfLenPx < 0.35) { halfLenPx = 0.0; }

  // Ink. A trail spreads the same light over a longer shape - but not with
  // strict conservation, which would make a long trail invisible; a long
  // exposure is allowed to gather light. The tail is a narrowing gaussian,
  // so it carries less than a full-width capsule would. Dust gives up a
  // little more, or a dense passage turns to straw. A defocused disc is
  // dimmer than the point it came from, though not strictly so either.
  let streakPower = select(0.40, 0.52, population == 0u);
  let streakGain = pow((3.14159 * drawnPx * drawnPx)
                       / (3.14159 * drawnPx * drawnPx + 1.8 * drawnPx * halfLenPx), streakPower);
  let cocGain = clamp(pow(rRef * pxScale / max(drawnPx, rRef * pxScale), 1.1), 0.14, 1.0);

  // Depth, by the view axis rather than the straight-line distance: at equal
  // depth an off-axis light must not be dimmer than one dead ahead, or the
  // centre of the frame fills in.
  let depthFade = 1.0 - smoothstep(z0, z1, zv);
  let depthDim = inverseSqrt(1.0 + (zv / z0) * (zv / z0));

  // Each population listens to its own register, so the arrangement is
  // legible in the picture: the bass lives in the big warm lights, the
  // melody in the lanterns, the hats in the dust. Every light has a floor,
  // so the journey goes on through silence.
  var lo = 0.55; var span = 0.45; var floorGain = 0.45; var gain = 0.55;   // dust: the top
  if (population == 1u) { lo = 0.20; span = 0.45; floorGain = 0.50; gain = 0.70; }
  if (population == 2u) { lo = 0.00; span = 0.25; floorGain = 0.50; gain = 0.90; }
  let bin = spectrum[u32(clamp(lo + h2.x * span, 0.0, 0.999) * BINS)];
  let listen = floorGain + gain * pow(max(bin, 0.0), 0.8);
  let slow = 1.0 + 0.045 * sin(U.time * (0.25 + h2.y * 0.3) + h2.z * 30.0);

  // The beat lands on the lights, not the camera: a brief swell that the
  // heroes carry most. Onsets catch the nearest lanterns, an instrument's
  // entry lifts the field, and a busy passage fills in the dust.
  let pulse = U.beat * exp(-U.beatAge * 5.0);
  let near = 1.0 - smoothstep(4.0, 24.0, zv);
  let onsetPick = step(0.7, h3.x);
  var event = 1.0 + U.onset * 0.22 * onsetPick * near + U.entry * 0.25;
  if (population == 2u) { event *= 1.0 + pulse * 0.22; }
  if (population == 1u) { event *= 1.0 + pulse * 0.10; }
  if (population == 0u) { event *= mix(0.45, 1.0, U.musicDensity) * (0.85 + U.high * 0.25); }
  if (population > 0u) { event *= 1.0 + U.voicePresence * 0.12; }

  let nearFade = smoothstep(0.45, 1.25, zv);
  // A lull thins the dust to almost nothing and leaves the lanterns.
  let quiet = mix(1.0, select(0.15, 0.78, population > 0u), U.lull) * (1.0 - U.breath * 0.08);
  // Presets change the count; the look must not swing with it.
  let countGain = clamp(pow(12288.0 / f32(pathCount), 0.35), 0.7, 1.6);

  let alpha = peak * brightVary * listen * slow * event * nearFade * depthFade * depthDim
              * taper * collide * quiet * countGain * rasterGain * streakGain * cocGain;
  if (alpha < 0.0004) { return hidden(); }

  var color = lightColour(h3.y, h3.z);
  if (population == 1u) { color = lanternColour(h3.y, h3.z); }
  if (population == 2u) { color = mix(lightColour(0.9, h3.z), vec3f(1.0, 0.58, 0.24), 0.9); }
  // Discs differ a little in how they fall off toward the edge, so a run of
  // big ones is not a run of the same stamp.
  let shape = rim + (h4.z - 0.5) * 0.08;
  return sprite(vi, centre, axis, drawnPx, halfLenPx, color, alpha, kind, shape, depthOf(v.z));
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // The head is the light itself, at +halfLen; behind it a tail narrows and
  // fades toward where the light was a shutter ago. A swept capsule of
  // constant width reads as a pill, not as motion.
  let L = in.halfLen;
  let x = in.local.x;
  let y = in.local.y;
  let rho = length(vec2f(x - L, y));      // distance from the head, in body radii
  let headPx = rho * in.radiusPx;
  let x0 = clamp(x, -L, L);
  let t = clamp((x0 + L) / max(2.0 * L, 1e-3), 0.0, 1.0);
  let hasTail = smoothstep(0.6, 3.0, L);
  let sigma = 0.20 + 0.32 * pow(t, 0.70);
  let tailD = length(vec2f(x - x0, y)) / sigma;
  let tail = (0.08 + 0.92 * pow(t, 1.6)) * exp(-0.5 * tailD * tailD) * hasTail;
  var a : f32;
  var core = 0.0;
  if (in.kind < 0.5) {
    a = exp(-0.5 * (rho / 0.48) * (rho / 0.48));
  } else {
    // Not a disc. A soft body of light with a wide halo: a lens-drawn disc
    // read as a sphere, and these are lights, not objects. The per-light
    // `rim` value now varies how soft the body is.
    let bodySigma = min(0.34 + in.rim * 0.6, 0.42);
    let body = exp(-0.5 * (rho / bodySigma) * (rho / bodySigma));
    let halo = 0.30 * exp(-0.5 * (rho / 0.85) * (rho / 0.85));
    if (in.kind < 1.5) {
      a = (body + halo) / 1.30;
      // A hot pale-gold core, a pixel or so wide, that survives focus. It is
      // what feeds the bloom.
      core = 0.6 * exp(-in.radiusPx / 24.0) * exp(-0.5 * (headPx / 1.2) * (headPx / 1.2));
    } else {
      // Heroes keep a compact highlight that survives focus.
      let hot = 0.5 * exp(-in.radiusPx / 20.0);
      a = (body + halo) / (1.30 + hot);
      core = hot * exp(-0.5 * (headPx / 1.1) * (headPx / 1.1)) / (1.30 + hot);
    }
  }
  // Head over tail, screened rather than summed, so the join does not bulge.
  a = 1.0 - (1.0 - a) * (1.0 - tail);
  a *= in.alpha;
  core *= in.alpha;
  if (a + core < 0.0002) { discard; }
  let gold = mix(in.color, vec3f(1.0, 0.82, 0.55), 0.7);
  return vec4f(in.color * a + gold * core, a + core);
}
