// A compact, linearly sampled curl atlas. Two depth slices are packed into
// RGBA so simulation retains parallax while replacing millions of noise calls.

@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var flowOut : texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn flowMain(@builtin(global_invocation_id) gid : vec3u) {
  let dims = textureDimensions(flowOut);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let world = (uv - 0.5) * vec2f(U.aspect * 3.1, -3.1);
  let scale = 0.52 + U.bass * 0.20;
  let t = U.time * 0.05;
  let shallow = curl2(world, t + 0.18, scale);
  let deep = curl2(world, t + 0.72, scale);
  textureStore(flowOut, vec2i(gid.xy), vec4f(shallow, deep));
}
