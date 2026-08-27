// Voyage: drifting through deep space.
//
// Dark, with a dense field of small sharp stars, soft nebula veils behind them,
// and a camera that wanders - yawing and pitching along a slow curved path
// rather than driving down a straight tunnel. Nothing is at the centre; the
// point is to pass things, not to approach anything.
//
// Three things learned the hard way and worth not undoing:
//
//   Stars must be SHARP. A soft 1/d^2 glow at any useful brightness reads as
//   overlapping blobs and fills the frame; the falloff has to be tight enough
//   that a star is a point with a small halo.
//
//   Space must be mostly EMPTY. A ridged-noise field thresholded near its mean
//   puts something on almost every ray, and the result is a flat wall of haze -
//   measured once at 0% of pixels near black.
//
//   Distance has to be WRAPPED. Left to accumulate it reaches the thousands
//   within a minute, the hash loses precision, and every sample returns noise.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;

const STEPS : i32 = 30;

fn vhash(p : vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

fn vnoise(p : vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(vhash(i), vhash(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(vhash(i + vec3f(0.0, 1.0, 0.0)), vhash(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(vhash(i + vec3f(0.0, 0.0, 1.0)), vhash(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(vhash(i + vec3f(0.0, 1.0, 1.0)), vhash(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

@fragment
fn fs(in : FullOut) -> @location(0) vec4f {
  let ndc = (in.uv - 0.5) * vec2f(U.aspect, 1.0) * 2.0;

  // The camera wanders. Yaw and pitch on slow incommensurate periods, so the
  // path curves continuously and never repeats a heading.
  let yaw = sin(U.time * 0.041) * 0.42 + sin(U.time * 0.017) * 0.24
            + U.voyageTurn * 0.10;
  let pitch = cos(U.time * 0.033) * 0.30 + cos(U.time * 0.013) * 0.18;
  let roll = sin(U.time * 0.023) * 0.25 + U.camAngle * 1.2;

  let cr = cos(roll);
  let sr = sin(roll);
  let screen = vec2f(ndc.x * cr - ndc.y * sr, ndc.x * sr + ndc.y * cr);
  var rd = normalize(vec3f(screen, 1.45 - U.level * 0.22));

  let cy = cos(yaw);
  let sy = sin(yaw);
  rd = vec3f(rd.x * cy + rd.z * sy, rd.y, rd.z * cy - rd.x * sy);
  let cp = cos(pitch);
  let sp = sin(pitch);
  rd = vec3f(rd.x, rd.y * cp - rd.z * sp, rd.y * sp + rd.z * cp);

  let z0 = U.voyageZ;
  // No dither. Stars are solved analytically below rather than sampled, so
  // there is no step aliasing to break up - and jittering the start would only
  // reintroduce the speckle it was there to hide.
  var t = 0.5;
  let origin = vec3f(0.0, 0.0, z0);

  var acc = vec3f(0.0);

  for (var i = 0; i < STEPS; i = i + 1) {
    let step = 0.86 + t * 0.10;
    let p = vec3f(0.0, 0.0, z0) + rd * t;

    // --- stars -------------------------------------------------------------
    // One candidate per cell, most cells empty. Sharp falloff so these stay
    // points with a small halo rather than merging into cloud.
    let cellSize = 0.90;
    let cell = floor(p / cellSize);
    let h = hash31(dot(cell, vec3f(1.0, 57.3, 113.7)));
    if (h.y > 0.80) {
      let site = (cell + 0.15 + h * 0.70) * cellSize;
      // The ray's closest approach to the star is SOLVED, not sampled. Marching
      // a point field with discrete steps makes a star's brightness depend on
      // where the nearest step happened to land, which differs per pixel, so a
      // point renders as a speckled cluster and the cell grid shows as planes.
      let toSite = site - origin;
      let along = dot(toSite, rd);
      if (along > 0.25) {
        let perp2 = max(dot(toSite, toSite) - along * along, 0.0);
        let band = fract(h.x * 3.17 + h.z * 0.41);
        let amp = spectrum[u32(clamp(band, 0.0, 0.999) * BINS)];
        let star = 0.0016 / (perp2 * perp2 * 9.0 + 0.0020);
        // Falls off with distance. Without it every star on the ray weighs the
        // same, thirty of them sum, and the frame washes out.
        let far = 1.0 / (1.0 + along * along * 0.055);
        let tone = clamp(0.30 + band * 0.44 + amp * 0.30 + U.warmth * 0.10, 0.0, 1.0);
        // Bright against the dark: keeping space empty is what gives whatever
        // does pass the room to stand out.
        acc += palette(tone, U.mood) * min(star, 3.2) * far
               * (1.15 + amp * 4.2 + U.beat * exp(-U.beatAge * 5.0) * 1.3);
      }
    }

    // --- nebula ------------------------------------------------------------
    // A low, wide colour wash well behind the stars. Kept faint deliberately:
    // this is what turns into a flat wall if it is allowed any real density.
    let neb = vnoise(p * 0.085 + vec3f(0.0, 0.0, 11.0));
    // Gentle curve rather than a hard threshold. A steep smoothstep puts its
    // own iso-surface across the frame as large dark wedges.
    let veil = pow(max(neb - 0.34, 0.0) * 1.5, 2.0);
    if (veil > 0.002) {
      let tone = clamp(0.16 + neb * 0.42 + U.musicDensity * 0.16
                       + U.onset * 0.08, 0.0, 1.0);
      acc += palette(tone, U.mood) * veil * step
             * (1.0 / (1.0 + t * 0.09))
             * (0.0020 + U.level * 0.0060 + U.entry * 0.0110);
    }

    t += step;
  }

  // Distance fade, so the field recedes into black rather than piling up.
  return vec4f(acc * (1.0 - U.lull * 0.35), 1.0);
}
