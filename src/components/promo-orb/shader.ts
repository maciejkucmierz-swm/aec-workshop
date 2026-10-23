import { tgpu, d, std } from "typegpu";

// Flow adapted from claude-app-clone-main/shaderEffects/voiceOrb.ts.
// Session-state accents are decorative, not a measurement of audio loudness.
const positions = tgpu.const(d.arrayOf(d.vec2f, 3), [
  d.vec2f(-1, -1),
  d.vec2f(3, -1),
  d.vec2f(-1, 3),
]);
const texCoords = tgpu.const(d.arrayOf(d.vec2f, 3), [
  d.vec2f(0, 0),
  d.vec2f(2, 0),
  d.vec2f(0, 2),
]);

export const OrbParams = d.struct({
  time: d.f32,
  listening: d.f32,
  speaking: d.f32,
  primary: d.vec3f,
  accent: d.vec3f,
  highlight: d.vec3f,
});
export const orbParams = tgpu.accessor(OrbParams);

export const orbVertex = tgpu.vertexFn({
  in: { idx: d.builtin.vertexIndex },
  out: { pos: d.builtin.position, uv: d.vec2f },
})((input) => {
  "use gpu";
  return {
    pos: d.vec4f(positions.$[input.idx], 0, 1),
    uv: texCoords.$[input.idx],
  };
});

export const orbFragment = tgpu.fragmentFn({
  in: { uv: d.vec2f },
  out: d.vec4f,
})((input) => {
  "use gpu";
  const time = orbParams.$.time;
  const listening = orbParams.$.listening;
  const speaking = orbParams.$.speaking;
  const centeredUv = std.sub(std.mul(input.uv, 2), d.vec2f(1));
  const distance = std.length(centeredUv);
  const pulse = 0.5 + 0.5 * std.sin(time * 4.2);
  const radius = 0.76 + listening * (0.02 + pulse * 0.045) +
    speaking * (0.025 + pulse * 0.06);
  const glow = 0.08 + listening * 0.42 + speaking * 0.9;
  // Keep a crisp silhouette with enough pixel coverage to avoid jagged edges.
  const edgeWidth = std.max(0.003, std.fwidth(distance) * 0.75);
  const mask = 1 - std.smoothstep(radius - edgeWidth, radius + edgeWidth, distance);
  const inner = 1 - std.smoothstep(radius * 0.32, radius, distance);
  const edgeGlow =
    // A short, faint halo preserves depth without softening the silhouette.
    (1 - std.smoothstep(radius, radius + 0.06, distance)) *
    std.smoothstep(radius * 0.48, radius, distance);
  const orbUv = std.mul(
    centeredUv,
    (1 + 0.18 * 0.028 + std.sin(time) * 0.18 * 0.009 +
      (listening * 0.015 + speaking * 0.12) * std.sin(distance * 12 - time * 3.5)) *
      std.mix(1.14, 0.84, inner),
  );

  let phase = -time * 0.5;
  let wave = d.f32(0);
  for (const i of tgpu.unroll(std.range(8))) {
    wave += std.cos(d.f32(i) - phase - wave * orbUv.x);
    phase += std.sin(orbUv.y * d.f32(i) + wave);
  }

  const baseColor = d.vec3f(
    std.cos(orbUv.x * 2.6 + phase) * 0.52 + 0.48,
    std.cos(orbUv.y * 2.4 + wave * 0.34 - phase * 0.22) * 0.52 + 0.48,
    std.cos((orbUv.x + orbUv.y) * 1.8 + wave * 0.28 + phase * 0.18) * 0.5 + 0.5,
  );
  const flowA = std.smoothstep(0.18, 0.9, baseColor.r);
  const flowB = std.smoothstep(0.22, 0.88, baseColor.g);
  let color = std.mix(orbParams.$.primary, orbParams.$.accent, flowB * 0.8);
  color = std.mix(color, orbParams.$.highlight, inner * flowA * 0.85);
  color = std.mul(color, 0.8 + mask * 0.2);
  color = std.add(color, std.mul(orbParams.$.primary, edgeGlow * glow * 0.06));

  const alpha = std.clamp(mask + edgeGlow * 0.06 * glow, 0, 1);
  return d.vec4f(std.mul(std.clamp(color, d.vec3f(0), d.vec3f(1)), alpha), alpha);
});
