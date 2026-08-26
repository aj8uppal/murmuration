// Linear expansion of the deliberately low-resolution procedural backdrop.

@group(0) @binding(0) var blitSampler : sampler;
@group(0) @binding(1) var blitSource : texture_2d<f32>;

@fragment
fn blit(in : FullOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(blitSource, blitSampler, in.uv, 0.0).rgb, 1.0);
}
