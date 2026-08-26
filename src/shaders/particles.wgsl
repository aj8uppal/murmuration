// Velocity-stretched soft sprites, additively accumulated into the HDR target.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> P : array<Particle>;
@group(0) @binding(2) var<storage, read> spectrum : array<f32>;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) local   : vec2f,
  @location(1) halfLen : f32,
  @location(2) color   : vec3f,
  @location(3) alpha   : f32,
};

fn rot(v : vec2f) -> vec2f {
  let c = cos(U.camAngle);
  let s = sin(U.camAngle);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn worldToClip(w : vec2f) -> vec2f {
  let r = rot(w - U.camOffset) * U.camZoom;
  return vec2f(r.x / U.aspect, r.y);
}

fn dirToClip(d : vec2f) -> vec2f {
  let r = rot(d) * U.camZoom;
  return vec2f(r.x / U.aspect, r.y);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  var quad = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, 1.0));
  let q = quad[vi];

  let p = P[ii];
  let bi  = u32(clamp(p.band, 0.0, 0.9999) * BINS);
  let amp = spectrum[bi];

  // During a lull the entire field takes a slow spatial breath. Scaling from
  // the particle position preserves centre density instead of excavating it.
  let par = mix(0.88, 1.12, p.depth);
  let breathSpread = 1.0 + U.lull * 0.11 + U.breath * 0.18;
  let wp = p.pos * par * breathSpread;

  let sp = length(p.vel);
  let axis = select(vec2f(1.0, 0.0), p.vel / max(sp, 1e-5), sp > 1e-4);
  let perp = vec2f(-axis.y, axis.x);

  // A tiny deterministic population catches the light as hard, tight glints.
  let sparkleClass = smoothstep(0.990, 0.999, hash11(p.seed * 73.17 + 9.2));
  let sparklePulse = pow(max(0.0, sin(U.time * (1.7 + p.seed * 3.1)
                                      + p.seed * 91.0)), 10.0);
  let sparkle = sparkleClass * (0.28 + sparklePulse * 0.72);
  let hero = sparkleClass;

  // Far grains are tight and bright, near grains bloom into bokeh.
  var fullRadius = mix(0.0016, 0.0062, p.depth) * U.sizeScale * U.spriteScale
                   * (1.0 + U.level * 0.25) * mix(1.0, 0.44, sparkle);
  // Keep the farthest grains just above subpixel territory at Retina scale.
  let pixelFloor = U.invResolution.y * 1.15 / max(U.camZoom, 0.5);
  fullRadius = max(fullRadius, pixelFloor);

  // Coherent fields can run quickly, but speed must not map linearly to raster
  // area. Free dust approaches a short cinematic streak asymptotically;
  // sparkles retain the longer geometry that makes each glint read cleanly.
  let fullHalfLen = min(sp * 0.021, 0.042) * U.sizeScale * U.spriteScale
                    * mix(1.0, 0.30, sparkle);
  let softSpeed = sp / (1.0 + sp * 2.4);
  let dustHalfLen = softSpeed * 0.022 * U.sizeScale * U.spriteScale;
  let performanceHalfLen = mix(dustHalfLen, fullHalfLen, hero);

  // Particle count only tightens the free population. Its N-dependent width
  // makes preset scaling sublinear while the pixel floor prevents aliasing.
  let qualityLoad = clamp((U.particleCount - 260000.0) / 940000.0, 0.0, 1.0);
  let dustWidth = mix(0.46, 0.28, qualityLoad);
  let performanceRadius = max(fullRadius * mix(dustWidth, 1.0, hero), pixelFloor);

  // Preserve additive ink as raster area falls. This is deliberately derived
  // from the actual old/new capsule areas rather than tuned per preset.
  let fullArea = fullRadius * (fullHalfLen + fullRadius);
  let performanceArea = performanceRadius * (performanceHalfLen + performanceRadius);
  let inkCompensation = clamp(fullArea / max(performanceArea, 1e-8), 1.0, 8.0);

  // Minor passages separate into finer strands; major passages gather very
  // slightly. The breath thins and shortens only free dust, leaving glints as
  // quiet points of reference in the negative space.
  let major = max(U.musicalMode, 0.0);
  let minor = max(-U.musicalMode, 0.0);
  let modeWidth = 1.0 + major * 0.035 - minor * 0.080;
  let quietWidth = mix(1.0, 0.74, U.lull) * (1.0 - U.breath * 0.08);
  let quietLength = mix(1.0, 0.78, U.lull) * (1.0 - U.breath * 0.06);
  let radius = max(performanceRadius
                   * mix(modeWidth * quietWidth, 1.0, hero), pixelFloor);
  let halfLen = performanceHalfLen * mix(quietLength, 1.0, hero);

  let off = axis * (q.x * (halfLen + radius)) + perp * (q.y * radius);

  var o : VSOut;
  let centre = worldToClip(wp);
  var clipPos = centre + dirToClip(off);
  let clipPad = vec2f((halfLen + radius) * U.camZoom / U.aspect,
                      (halfLen + radius) * U.camZoom);
  // All six vertices collapse to one point when the complete capsule is out.
  if (abs(centre.x) > 1.0 + clipPad.x || abs(centre.y) > 1.0 + clipPad.y) {
    clipPos = vec2f(2.0);
  }
  o.pos     = vec4f(clipPos, 0.0, 1.0);
  o.local   = vec2f(q.x * (halfLen + radius) / radius, q.y);
  o.halfLen = halfLen / radius;

  // Spatial interference and velocity direction give colour coherent veins,
  // while a restrained thin-film shift glances across the fastest filaments.
  let structure = 0.5 + 0.5 * sin(p.pos.x * 2.1
                    + sin(p.pos.y * 2.8 - U.time * 0.055) * 1.7
                    + p.depth * 2.4);
  let directionHue = atan2(axis.y, axis.x) / TAU + 0.5;
  let e = clamp(sp * 0.95, 0.0, 1.0);
  // Exercise the whole active ramp at once. Spatial structure and shared
  // direction dominate, so the extra hue range forms broad veins rather than
  // assigning every neighbouring dust mote an unrelated colour.
  let t = fract(0.03 + structure * 0.82 + directionHue * 0.28
                + p.band * 0.24 + p.depth * 0.12 + e * 0.12 + U.high * 0.08
                + amp * 0.10 + U.warmth * 0.08);
  let film = 0.5 + 0.5 * sin(directionHue * TAU * 2.7 + sp * 8.0
                             + p.depth * 4.0 - U.time * 0.10);
  let filmMix = 0.10 + e * 0.18 + minor * 0.05 - major * 0.025;
  var col = mix(palette(t, U.mood), palette(fract(t + 0.10 + film * 0.16), U.mood),
                filmMix);
  let transient = U.beat * exp(-U.beatAge * 5.0);
  col = col * (0.20 + amp * 1.45 + U.level * 0.28 + transient * 0.58
               + U.onset * 0.26 + U.entry * 0.46 + U.phasePulse * 0.055)
        * (1.0 + sparkle * 2.6);
  col *= vec3f(1.0 + major * 0.035 - minor * 0.020,
               1.0 + major * 0.010 + minor * 0.012,
               1.0 - major * 0.025 + minor * 0.045);

  // Energy per sprite is roughly conserved, so bokeh discs stay soft.
  let bright = mix(1.55, 0.22, p.depth);
  let fade = smoothstep(0.0, 0.20, p.life) * smoothstep(1.62, 1.22, p.life);
  let quietKeep = mix(1.0, smoothstep(0.52, 0.94, p.seed), U.lull);
  let visibility = mix(quietKeep, 1.0, sparkleClass);
  let quietEnergy = mix(1.0, 0.62, U.lull) * (1.0 - U.breath * 0.14);
  let eventEnergy = 1.0 + U.onset * 0.22 + U.entry * 0.38
                    + U.phasePulse * 0.05;
  let modeEnergy = 1.0 + major * 0.035 - minor * 0.040;

  o.color = col;
  o.alpha = 0.0092 * U.density * bright * fade
            * (0.40 + amp * 0.95) * (1.0 + sparkle * 1.35)
            * inkCompensation * visibility * quietEnergy
            * eventEnergy * modeEnergy;
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // Capsule distance field -> gaussian falloff.
  let d = length(vec2f(max(abs(in.local.x) - in.halfLen, 0.0), in.local.y));
  let a = exp(-d * d * 2.7) * in.alpha;
  if (a < 0.00028) { discard; }
  return vec4f(in.color * a, a);
}
