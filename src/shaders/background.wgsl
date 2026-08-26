// Deep-field backdrop: negative space, slow aurora veils, faint stars.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var<storage, read> spectrum : array<f32>;

fn stars(p : vec2f, density : f32) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let h = hash22(cell);
  if (h.x > density) { return 0.0; }
  let c = vec2f(0.25 + h.y * 0.5, 0.25 + h.x * 0.5);
  let d = length(f - c);
  let tw = 0.55 + 0.45 * sin(U.time * (0.6 + h.y * 2.2) + h.x * 30.0);
  return exp(-d * d * 320.0) * tw;
}

@fragment
fn fs(in : FullOut) -> @location(0) vec4f {
  let uv = in.uv;
  let p = vec2f((uv.x - 0.5) * 2.0 * U.aspect, (0.5 - uv.y) * 2.0);
  let quiet = clamp(U.lull * (0.86 + U.breath * 0.14), 0.0, 1.0);
  let veilEnergy = mix(1.0, 0.34, quiet)
                   * (1.0 + U.entry * 0.18 + U.onset * 0.05);

  // Base gradient stays close to black so the particle choreography can breathe.
  let g = smoothstep(-1.2, 1.1, p.y);
  let baseTint = palette(0.12, U.mood) * 0.055;
  var col = mix(vec3f(0.0025, 0.0035, 0.0090) + baseTint * 0.28,
                vec3f(0.0008, 0.0018, 0.0060) + baseTint * 0.10, g);

  // Two aurora sheets drifting at different rates, lit by the low band.
  let t = U.time * 0.035;
  let n1 = fbm3(vec3f(p * 0.62 + vec2f(0.0, t * 2.0), t), 4);
  let n2 = fbm3(vec3f(p * 0.31 + vec2f(t * 1.3, 0.0), t * 0.7 + 19.0), 3);

  let sheet1 = smoothstep(0.22, 0.98, n1 * 0.5 + 0.5) * (0.030 + U.bass * 0.10);
  let sheet2 = smoothstep(0.34, 1.00, n2 * 0.5 + 0.5) * (0.020 + U.lowMid * 0.07);

  let veilA = palette(0.34 + n2 * 0.12, U.mood);
  let veilB = palette(0.67 + n1 * 0.10, U.mood);
  col += veilA * sheet1 * 0.66 * veilEnergy;
  col += veilB * sheet2 * 0.48 * veilEnergy;

  // Analytic caustics change character with the flow bank without adding more
  // simplex work. Their narrow gaps create useful dark structure.
  let fan = 0.5 + 0.5 * sin(atan2(p.y, p.x) * (5.0 + U.flowMode * 1.4)
                                - length(p) * 6.0 + U.time * 0.055);
  let ribbons = pow(max(fan, 0.0), 9.0) * exp(-length(p) * 0.75);
  col += palette(0.78, U.mood) * ribbons * (0.002 + U.high * 0.012)
         * mix(1.0, 0.42, quiet);

  // Central bloom haze that breathes with overall level.
  let rl = length(p * vec2f(0.85, 1.0));
  let rn = rl / length(vec2f(U.aspect * 0.85, 1.0));
  col += palette(0.30, U.mood) * exp(-rn * rn * 3.4)
         * ((0.010 + U.level * 0.028 + U.interactionGlow * 0.008)
            * mix(1.0, 0.38, quiet) + U.entry * 0.006);

  // Star field, parallaxed against the camera drift.
  let sp = (p - U.camOffset * 0.35) * 9.0;
  let s = stars(sp, 0.055) + stars(sp * 2.3 + 41.0, 0.030) * 0.6;
  col += palette(0.88, U.mood) * s * 0.105 * (0.55 + U.high * 1.1)
         * mix(1.0, 0.58, quiet);

  // Falloff toward the frame edges keeps the eye centred.
  col *= mix(1.0, 0.30, smoothstep(0.35, 1.0, rn));

  return vec4f(col, 1.0);
}
