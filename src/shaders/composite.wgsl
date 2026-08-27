// Final grade: shockwave warp, chromatic aberration, bloom + anamorphic streak,
// ACES tonemap, teal/amber split-tone, vignette, grain, dithered sRGB encode.

@group(0) @binding(0) var samp  : sampler;
@group(0) @binding(1) var scene : texture_2d<f32>;
@group(0) @binding(2) var bloom : texture_2d<f32>;
@group(0) @binding(3) var wide  : texture_2d<f32>;
@group(0) @binding(4) var<uniform> U : Uniforms;

fn streak(uv : vec2f) -> vec3f {
  var acc = vec3f(0.0);
  var wsum = 0.0;
  // The source is already a very wide bloom reduction. Seven broad taps read
  // cleaner than 17 overlapping taps and remove ten full-res texture reads.
  for (var i = -3; i <= 3; i = i + 1) {
    let fi = f32(i);
    let w = exp(-fi * fi * 0.30);
    let o = vec2f(fi * 0.045, 0.0);
    acc += textureSampleLevel(wide, samp, uv + o, 0.0).rgb * w;
    wsum += w;
  }
  return acc / wsum;
}

@fragment
fn fs(in : FullOut) -> @location(0) vec4f {
  var uv = in.uv;
  let centred = (uv - 0.5) * vec2f(U.aspect, 1.0);
  let rl = length(centred);
  let dir = centred / max(rl, 1e-5);
  // Normalised so the corner always sits at 1.0, whatever the window shape.
  let rn = rl / (length(vec2f(U.aspect, 1.0)) * 0.5);

  // The flight keeps its optics still: no beat warp, no beat aberration, a
  // shallow vignette and only a trace of the anamorphic streak. Every one of
  // those would turn an open field of lights back into a corridor.
  let voy = clamp(U.mode, 0.0, 1.0);

  // Expanding ring displacement fired on each detected beat.
  let ringR = U.beatAge * 0.9;
  let ring = exp(-pow((rn - ringR) * 7.0, 2.0)) * U.beat * exp(-U.beatAge * 3.0)
             * (1.0 - voy);
  uv += dir * ring * 0.010 / vec2f(U.aspect, 1.0);

  // A click bends the image around its own expanding pressure front.
  let burstUv = vec2f(0.5 + U.burstPos.x / (2.0 * U.aspect),
                      0.5 - U.burstPos.y * 0.5);
  let bv = (uv - burstUv) * vec2f(U.aspect, 1.0);
  let br = length(bv);
  let bdir = bv / max(br, 1e-4);
  let clickRing = exp(-pow((br - U.burstAge * 0.64) * 12.0, 2.0))
                  * U.burstStrength * exp(-U.burstAge * 2.4);
  uv += bdir * clickRing * 0.015 / vec2f(U.aspect, 1.0);

  // Radial chromatic aberration, stronger at the edges and on transients.
  let ca = (0.0007 + U.beat * exp(-U.beatAge * 6.0) * 0.0026 * (1.0 - voy) + U.level * 0.0006)
           * (0.20 + rn * rn * 1.2);
  let off = dir * ca / vec2f(U.aspect, 1.0);

  var base : vec3f;
  base.r = textureSampleLevel(scene, samp, uv + off, 0.0).r;
  base.g = textureSampleLevel(scene, samp, uv, 0.0).g;
  base.b = textureSampleLevel(scene, samp, uv - off, 0.0).b;

  let bl = textureSampleLevel(bloom, samp, uv, 0.0).rgb;
  let st = streak(uv) * vec3f(0.42, 0.62, 1.0);

  // Lulls pull even the halo back into negative space. Instrument entry
  // briefly restores a broad glow; onsets only catch the nearest highlights.
  let sty = styleAt(U.style);
  let bloomGain = U.bloomStrength * sty.bloom * mix(1.0, 0.72, U.lull)
                  * (1.0 + U.entry * 0.30 + U.onset * 0.06);
  var col = base + bl * bloomGain + st * bloomGain * mix(0.55, 0.08, voy);

  // A faint local afterglow makes painted interaction read in the final grade.
  let pointerUv = vec2f(0.5 + U.pointer.x / (2.0 * U.aspect), 0.5 - U.pointer.y * 0.5);
  let pointerD = length((in.uv - pointerUv) * vec2f(U.aspect, 1.0));
  col += palette(0.72, U.mood) * exp(-pointerD * pointerD * 38.0)
         * U.interactionGlow * 0.018;

  col *= U.exposure;
  col = aces(col);

  // Palette-aware split tone connects the whole frame without tinting blacks.
  let l = luma(col);
  let shadow = mix(vec3f(0.88, 0.96, 1.06), palette(0.20, U.mood) + 0.78, 0.16);
  let highl  = mix(vec3f(1.04, 1.00, 0.94), palette(0.82, U.mood) + 0.70, 0.10);
  col *= mix(shadow, highl, smoothstep(0.10, 0.72, l));
  col = mix(vec3f(l), col, 1.10);
  // Style contrast, pivoted at mid grey so it darkens shadows rather than
  // simply gaining the whole frame.
  col = clamp((col - 0.18) * sty.contrast + 0.18, vec3f(0.0), vec3f(1.0));

  // Vignette.
  col *= mix(1.0, mix(0.18, 0.48, voy), smoothstep(0.30, 1.0, rn));

  // Animated grain, slightly heavier in the shadows where banding shows.
  let gn = hash22(in.pos.xy + vec2f(U.frame * 1.7, U.frame * 0.31)).x - 0.5;
  // A restrained film-grain veil: enough motion to keep the blacks alive,
  // without turning sparse flow modes into coarse, high-contrast speckle.
  col += gn * U.grain * (0.18 + (1.0 - smoothstep(0.0, 0.45, l)) * 0.36);

  var srgb = linearToSrgb(max(col, vec3f(0.0)));
  // Ordered dither breaks up 8-bit banding across the dark gradients.
  let d = (hash22(in.pos.xy * 0.7 + U.frame).y - 0.5) / 255.0;
  srgb += d;

  // Preserve coloured highlight detail; even the brightest glints stay shy of
  // display white, avoiding the old additive blow-out failure mode.
  return vec4f(clamp(srgb, vec3f(0.0), vec3f(0.985)), 1.0);
}
