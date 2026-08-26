// Progressive bloom: 13-tap Karis downsample chain, 9-tap tent upsample chain.

struct BloomParams {
  texel     : vec2f,
  threshold : f32,
  knee      : f32,
  scatter   : f32,
  mode      : f32,   // 1.0 on the prefilter pass
  _pad      : vec2f,
};

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var src  : texture_2d<f32>;
@group(0) @binding(2) var<uniform> B : BloomParams;

fn fetch(uv : vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv, 0.0).rgb;
}

// Karis weighting suppresses single-pixel fireflies on the first reduction.
fn karis(c : vec3f) -> f32 { return 1.0 / (1.0 + luma(c)); }

fn prefilter(c : vec3f) -> vec3f {
  let br = max(c.r, max(c.g, c.b));
  let knee = max(B.knee, 1e-4);
  var soft = br - B.threshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  let contrib = max(soft, br - B.threshold) / max(br, 1e-5);
  return c * contrib;
}

@fragment
fn downsample(in : FullOut) -> @location(0) vec4f {
  let t = B.texel;
  let uv = in.uv;

  let a = fetch(uv + t * vec2f(-2.0,  2.0));
  let b = fetch(uv + t * vec2f( 0.0,  2.0));
  let c = fetch(uv + t * vec2f( 2.0,  2.0));
  let d = fetch(uv + t * vec2f(-2.0,  0.0));
  let e = fetch(uv);
  let f = fetch(uv + t * vec2f( 2.0,  0.0));
  let g = fetch(uv + t * vec2f(-2.0, -2.0));
  let h = fetch(uv + t * vec2f( 0.0, -2.0));
  let i = fetch(uv + t * vec2f( 2.0, -2.0));

  let j = fetch(uv + t * vec2f(-1.0,  1.0));
  let k = fetch(uv + t * vec2f( 1.0,  1.0));
  let l = fetch(uv + t * vec2f(-1.0, -1.0));
  let m = fetch(uv + t * vec2f( 1.0, -1.0));

  var result : vec3f;
  if (B.mode > 0.5) {
    // Weighted per-group Karis average.
    let g0 = (j + k + l + m) * 0.25;
    let g1 = (a + b + d + e) * 0.25;
    let g2 = (b + c + e + f) * 0.25;
    let g3 = (d + e + g + h) * 0.25;
    let g4 = (e + f + h + i) * 0.25;
    let w0 = karis(g0) * 0.5;
    let w1 = karis(g1) * 0.125;
    let w2 = karis(g2) * 0.125;
    let w3 = karis(g3) * 0.125;
    let w4 = karis(g4) * 0.125;
    let wsum = max(w0 + w1 + w2 + w3 + w4, 1e-5);
    result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / wsum;
    result = prefilter(result);
  } else {
    result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
  }
  return vec4f(result, 1.0);
}

@fragment
fn upsample(in : FullOut) -> @location(0) vec4f {
  let t = B.texel;
  let uv = in.uv;

  var s = fetch(uv + t * vec2f(-1.0,  1.0)) * 1.0;
  s += fetch(uv + t * vec2f( 0.0,  1.0)) * 2.0;
  s += fetch(uv + t * vec2f( 1.0,  1.0)) * 1.0;
  s += fetch(uv + t * vec2f(-1.0,  0.0)) * 2.0;
  s += fetch(uv)                          * 4.0;
  s += fetch(uv + t * vec2f( 1.0,  0.0)) * 2.0;
  s += fetch(uv + t * vec2f(-1.0, -1.0)) * 1.0;
  s += fetch(uv + t * vec2f( 0.0, -1.0)) * 2.0;
  s += fetch(uv + t * vec2f( 1.0, -1.0)) * 1.0;

  return vec4f(s * (1.0 / 16.0) * B.scatter, 1.0);
}
