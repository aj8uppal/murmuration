// Voyage: flying forward through space.
//
// A raymarch rather than a particle system. The camera advances along a
// corridor that banks and rolls, and what rushes past is a jittered lattice of
// glowing points plus a soft haze on the corridor wall. Everything about the
// flight is the music's: how fast you travel, how tight the corridor is, what
// colour the field ahead is, and how hard the walls flare on a transient.
//
// Deliberately analytic. Marching fbm at this step count would cost hundreds of
// millions of noise evaluations per frame; a hashed lattice gives the same
// sense of structure rushing past for a fraction of the work.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;

const STEPS : i32 = 48;

/** Where the corridor centre sits at a given distance along it. */
fn corridorAt(z : f32, turn : f32) -> vec2f {
  return vec2f(sin(z * 0.055) * 2.6 + sin(z * 0.021) * 1.4,
               cos(z * 0.043) * 1.9 + cos(z * 0.017) * 1.1) * turn;
}

@fragment
fn fs(in : FullOut) -> @location(0) vec4f {
  let ndc = (in.uv - 0.5) * vec2f(U.aspect, 1.0) * 2.0;

  // Roll the horizon with the corridor's bank, so turns are felt rather than
  // merely seen.
  let roll = U.voyageTurn * 0.22 + U.camAngle * 1.6;
  let cr = cos(roll);
  let sr = sin(roll);
  let screen = vec2f(ndc.x * cr - ndc.y * sr, ndc.x * sr + ndc.y * cr);

  // A wider field of view under pressure reads as speed.
  let fov = 1.55 - U.level * 0.30 - U.beat * exp(-U.beatAge * 4.0) * 0.18;
  let rd = normalize(vec3f(screen, fov));

  let z0 = U.voyageZ;
  let tunnelRadius = 2.30 + U.bass * 1.15 - U.lull * 0.55;

  var acc = vec3f(0.0);
  // Dither the ray start per pixel. Marching a cell lattice on a fixed grid
  // makes neighbouring pixels cross the same cell boundaries at the same depth,
  // and those aligned discontinuities read as hard facets. Offsetting each ray
  // turns that structured error into fine noise, which the bloom then hides.
  var t = 0.35 + hash22(in.pos.xy + vec2f(U.frame * 0.37, 0.0)).x * 0.42;
  // Steps lengthen with distance: near detail stays crisp, far haze stays cheap.
  for (var i = 0; i < STEPS; i = i + 1) {
    let step = 0.16 + t * 0.085;
    let p = vec3f(0.0, 0.0, z0) + rd * t;
    let centre = corridorAt(p.z, 1.0);
    let radial = p.xy - centre;
    let r = length(radial);

    // Lattice of points, jittered per cell, thinned near the corridor axis so
    // there is somewhere to fly. Rotated off the world axes: an axis-aligned
    // lattice puts its own grid planes through the vanishing point and draws a
    // hard cross across the middle of the screen.
    let cellSize = 1.55;
    let lat = vec3f(
      radial.x * 0.8827 - radial.y * 0.4699,
      radial.x * 0.4699 + radial.y * 0.8827,
      p.z * 0.9613 + radial.x * 0.2755);
    let cell = floor(lat / cellSize);
    let jitter = hash31(dot(cell, vec3f(1.0, 57.3, 113.7)));
    // Jittered most of a cell wide. At 0.3 the sites still sat close enough to
    // their grid that the lattice planes stayed visible as faint diagonals.
    let site = (cell + 0.22 + jitter * 0.56) * cellSize;
    let toSite = lat - site;
    let d2 = dot(toSite, toSite);

    // Each cell listens to its own part of the spectrum.
    let bandPick = fract(jitter.x * 3.17 + jitter.z * 0.41);
    let amp = spectrum[u32(clamp(bandPick, 0.0, 0.999) * BINS)];

    let alive = step_alive(r, tunnelRadius, jitter.y);
    // Capped: 1/d^2 is unbounded as a cell passes through the camera, and an
    // uncapped near hit turns into a screen-filling smear.
    // Capped well above the typical hit. At 0.085 so many samples clipped that
    // the accumulation flattened into visible facets rather than points.
    let glow = min(alive * (0.0014 + amp * 0.0068) / (d2 * 0.55 + 0.012), 0.34);

    // Colour by which band the cell answers to, warmed by depth and transients.
    // Spread the tone across the whole ramp, and give each cell its own offset,
    // so the field ahead is not one colour rushing past.
    let tone = clamp(bandPick * 0.78 + jitter.z * 0.22 + amp * 0.26
                     + U.warmth * 0.14 + U.onset * 0.10, 0.0, 1.0);
    acc += palette(tone, U.mood) * glow * step;

    // Corridor wall: a soft shell that flares on transients.
    let shell = exp(-pow((r - tunnelRadius) * 1.05, 2.0));
    let wallTone = clamp(0.20 + U.high * 0.40 + U.attack * 0.25, 0.0, 1.0);
    acc += palette(wallTone, U.mood) * shell
           * (0.0022 + U.entry * 0.010 + U.beat * exp(-U.beatAge * 5.0) * 0.006)
           * step;

    t += step;
  }

  // Depth haze so the far end of the corridor recedes rather than piling up.
  acc *= 1.0 - U.lull * 0.45;
  return vec4f(acc, 1.0);
}

/** Cells fade out inside the corridor and thin out far beyond its wall. */
fn step_alive(r : f32, radius : f32, roll : f32) -> f32 {
  // A wider hollow centre so there is visibly a corridor to fly down rather
  // than a cloud to fly into.
  let inner = smoothstep(radius * 0.62, radius * 1.10, r);
  let outer = 1.0 - smoothstep(radius * 1.9, radius * 3.4, r);
  // Smooth, not binary. A hard per-cell cutoff draws cell-shaped patches
  // wherever the radial terms are visible through it.
  return inner * outer * smoothstep(0.22, 0.62, roll);
}
