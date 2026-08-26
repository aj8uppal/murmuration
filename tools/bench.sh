#!/usr/bin/env bash
# Measure frame cost at each quality preset.
#
#   ./tools/bench.sh [resolutionScale] [port]
#
# Reports GPU time per frame: submits frames back to back and waits on
# onSubmittedWorkDone, so the number is the renderer's own cost rather than
# whatever the machine happened to be doing. Wall-clock frame deltas turned out
# to be useless here - on a loaded machine they read 19ms for work that takes
# the GPU 10ms, and the run-to-run spread was wider than the effects being
# measured. The rAF median is still printed alongside, since that is what the
# user actually experiences.
#
# Four things matter for the numbers to mean anything, all learned the hard way:
#
#   1. Every open visualiser tab keeps rendering. Measuring with leftovers open
#      produced 620k looking slower than 1.2M. Each run closes them first.
#   2. One configuration per page load. Long evals that reallocate the particle
#      buffer mid-flight hang the devtools bridge.
#   3. Wait for `frameIndex >= 40`, not for `renderer.device`. The device handle
#      exists before the sampler and bind groups do, and touching
#      setResolutionScale in that window throws from Renderer.resize.
#   4. Drive pixel count with setResolutionScale, never the bridge's `resize`.
set -euo pipefail

SCALE="${1:-1.5}"
PORT="${2:-8173}"
URL="http://127.0.0.1:$PORT/index.html"

command -v chrome-devtools-axi >/dev/null || { echo "chrome-devtools-axi not found" >&2; exit 1; }
curl -sf -o /dev/null "$URL" || { echo "nothing serving on $PORT - run ./serve.sh" >&2; exit 1; }

close_tabs () {
  for id in $(chrome-devtools-axi pages 2>&1 | awk -F, '/,je,/{print $1}' | tr -d ' '); do
    chrome-devtools-axi closepage "$id" >/dev/null 2>&1 || true
  done
}

measure () {
  local count="$1" tag="$2"
  close_tabs
  sleep 2
  chrome-devtools-axi newpage "$URL?bench=$tag" >/dev/null 2>&1 && chrome-devtools-axi eval "async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150 && (typeof viz === 'undefined' || !viz.renderer.frameIndex || viz.renderer.frameIndex < 40); i++) await sleep(100);
    if (typeof viz === 'undefined' || !viz.renderer.sampler) return 'NOT READY';
    viz.autoScaled = true;
    viz.renderer.setResolutionScale($SCALE);
    viz.renderer.setParticleCount($count);
    await sleep(2500);

    const d = [];
    await new Promise(res => { let k = 0, last = performance.now();
      const tick = () => { const now = performance.now(); d.push(now - last); last = now;
        if (++k < 100) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick); });
    d.sort((a, b) => a - b);
    const wall = d[Math.floor(d.length / 2)];

    // Borrow one real state object, then drive the renderer directly.
    let st = null;
    const orig = viz.renderer.frame.bind(viz.renderer);
    viz.renderer.frame = (s) => { st = s; return orig(s); };
    await sleep(300);
    viz.renderer.frame = orig;

    const dev = viz.renderer.device;
    const runs = [];
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 10; i++) orig(st);
      await dev.queue.onSubmittedWorkDone();
      const N = 60, t0 = performance.now();
      for (let i = 0; i < N; i++) orig(st);
      await dev.queue.onSubmittedWorkDone();
      runs.push((performance.now() - t0) / N);
    }
    runs.sort((a, b) => a - b);
    const gpu = runs[1];
    const mp = (viz.renderer.width * viz.renderer.height) / 1e6;
    return viz.renderer.width + 'x' + viz.renderer.height + ' (' + mp.toFixed(1) + 'MP)  gpu '
         + gpu.toFixed(2) + ' ms (' + (1000 / gpu).toFixed(0) + ' fps)   wall ' + wall.toFixed(1) + ' ms';
  }" 2>&1 | head -1 | sed 's/^result: //; s/^"//; s/"$//; s/\\"//g'
}

printf '%-8s %s\n' "preset" "result"
printf '%-8s %s\n' "calm"   "$(measure 260000 calm)"
printf '%-8s %s\n' "full"   "$(measure 620000 full)"
printf '%-8s %s\n' "lavish" "$(measure 1200000 lavish)"
close_tabs
