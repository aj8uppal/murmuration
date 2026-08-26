# Renderer state handoff

All fields below are optional. `Renderer.frame(state)` supplies the listed
fallbacks, so the piece is fully animated and interactive before `main.js`
wires any of them.

| field | meaning | expected range / units | fallback |
| --- | --- | --- | --- |
| `mood` | Continuous position in the cinematic palette bank: 0 ocean, 1 ember/gold, 2 violet aurora, 3 silver, 4 cold neon. Fractional values crossfade. | `0..4` | Automatic 0→4→0 journey, one bank every 26 seconds. |
| `flowMode` | Continuous position in the motion bank: 0 curl silk, 1 radial rays, 2 vortex braids, 3 laminar sheets. Fractional values crossfade. | `0..3` | Automatic 0→3→0 journey, one mode every 18 seconds; renderer `G` selection overrides this until Shift+G. |
| `pointerDown` | Enables the strong pointer force. This is combined with the renderer's direct pointer listener. | `0` or `1` | Direct canvas pointer state, otherwise `0`. |
| `pointerStrength` | Pointer force polarity and gain. Positive attracts; negative repels. | Recommended `-2..2` | Direct interaction uses `1`, or `-1` while Shift-dragging. |
| `pointerVelX` | Horizontal drag velocity injected into nearby particles. | World units / second, recommended `-4..4` | Velocity measured by the renderer's canvas listener, decaying to `0`. |
| `pointerVelY` | Vertical drag velocity injected into nearby particles. | World units / second, recommended `-4..4` | Velocity measured by the renderer's canvas listener, decaying to `0`. |
| `burstX` | World-space X centre of an interaction shockwave. Same coordinate system as existing `pointerX`. | Approximately `-aspect..aspect` | Last direct canvas click, initially `0`. |
| `burstY` | World-space Y centre of an interaction shockwave. Same coordinate system as existing `pointerY`. | Approximately `-1..1` | Last direct canvas click, initially `0`. |
| `burstAge` | Seconds since the burst fired; set to `0` for one frame to trigger it, then increment every frame. | `0..10` seconds | Renderer-managed click age, initially `99` (inactive). |
| `burstStrength` | Signed shockwave gain. Positive expands; negative implodes. | Recommended `-2..2` | Direct click uses `1`; Shift-click uses `-0.8`; initially `0`. |
| `zoom` | Optional interactive zoom multiplier applied on top of existing `camZoom`. Do not pass it if wheel zoom is already folded into `camZoom`. | Recommended `0.68..1.75` | `1`. |
| `interactionGlow` | Optional art-direction override for the subtle local pointer/path afterglow. | `0..1` | Derived from pointer hold, burst envelope, and painted-path persistence. |

## Interaction already wired in `renderer.js`

Do not duplicate these listeners in `main.js` unless the renderer-side version
is deliberately removed:

- Canvas pointer move/down/up/cancel: immediate position and velocity, strong
  attractor drag, click shockwave, and a six-node persistent path that fades
  over roughly ten seconds.
- Shift-click / Shift-drag: implosive burst and repulsor paint instead of
  attraction.
- `G`: step through the four flow behaviours. Shift+G returns to the automatic
  flow journey supplied by state (or the renderer fallback).
- Canvas context menu is suppressed so alternate interaction remains
  uninterrupted.

The existing `pointerX` / `pointerY` fields remain supported. Once the pointer
has entered the canvas, the renderer uses its immediate canvas-local position
to keep direct manipulation crisp; otherwise it falls back to those existing
state values.

The current `main.js` already folds wheel input into `camZoom` and passes the
fallback pointer position plus mood/flow fields. The renderer owns pointer
force, burst, and painted-path state and intentionally does not attach a second
wheel listener. Keep that single-owner arrangement to avoid double zoom.
