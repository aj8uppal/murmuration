// Stills of the piece from headless Chrome, driven over the DevTools
// protocol with nothing but node's own WebSocket - no dependencies.
//
//   ./serve.sh &
//   node tools/shot.mjs <outdir> <mode index> <spec> [window]
//
//   outdir      where the jpgs go
//   mode index  how many times to press B: 0 particle, 1 warp, and with
//               ?modes=all in the URL below, 2 voyage, 3 current, 4 plate
//   spec        comma-separated phases, "label:seconds[:boost[:sweep]]" -
//               each phase waits, then saves <label>.jpg. `boost` 1 holds
//               the warp's throttle through the phase; `sweep` 1 or -1
//               forces a full phrase sweep to that side at its start, to
//               see a hard bend.
//   window      "width,height", default 1600,1000
//
//   SEEK=0.55 node tools/shot.mjs shots 1 "cruise:5,burn:5:1,coast:4,bend:4:0:1"
//
// The bundled track is started and seeked to SEEK (a fraction, default
// 0.55: a full passage). Each phase also prints the warp's state and the
// analyser's band means.
//
// Two things about headless Chrome, learned the hard way: a screenshot
// capture leaves the page's animation loop crawling at a frame a second
// until the page is brought to the front again, so every capture is
// followed by Page.bringToFront; and a value set from outside can be lost
// across a capture, so the throttle is re-asserted through each wait.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [,, outDir = 'shots', modeIndex = '1', spec = 'cruise:6,burn:4:1,coast:3', size = '1600,1000'] = process.argv;
const port = Number(process.env.PORT ?? 8173);
const debugPort = 9333;
mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--window-size=${size}`,
  '--enable-unsafe-webgpu', '--use-angle=metal', '--enable-features=WebGPU',
  '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--no-first-run',
  `--user-data-dir=${outDir}/profile`, 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${debugPort}${path}`); return await r.json(); } catch { await sleep(200); }
  }
  throw new Error('chrome did not answer');
}

const page = (await json('/json')).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (msg.method === 'Runtime.exceptionThrown') logs.push(`EXC ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
};
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html?modes=all` });
await sleep(1500);
for (let i = 0; i < 100; i++) {
  if (await evaluate('typeof viz !== "undefined" && viz.renderer.frameIndex > 40')) break;
  await sleep(200);
}
console.log('describe:', await evaluate('viz.renderer.describe()'));
await evaluate('document.querySelector("#btn-song").click(); true');
for (let i = 0; i < 100; i++) {
  if (await evaluate('viz.started === true && viz.audio.playing')) break;
  await sleep(200);
}
await evaluate(`viz.audio.seek(${Number(process.env.SEEK ?? 0.55)}); true`);
const mode = await evaluate(`(() => {
  for (let i = 0; i < ${Number(modeIndex)}; i++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB' }));
  return document.querySelector('#mode').textContent;
})()`);
console.log('mode:', mode);
await evaluate('document.body.classList.add("chrome-hidden"); true');

for (const item of spec.split(',')) {
  const [label, secs, boost, sweep] = item.split(':');
  if (sweep) {
    await evaluate(`Object.assign(viz.warp, { breathArmed: false, breathT: 0, breathLen: 6, breathAmp: 1.25, turnDir: ${Number(sweep)} }); true`);
  }
  for (let t = 0; t < Number(secs) * 1000; t += 250) {
    await evaluate(`viz.pointerHeld = ${boost === '1'}; true`);
    await sleep(250);
  }
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  writeFileSync(`${outDir}/${label}.jpg`, Buffer.from(shot.result.data, 'base64'));
  await send('Page.bringToFront');
  const info = await evaluate(`JSON.stringify({
    fps: Math.round(viz.fps), t: viz.audio.currentTime.toFixed(1),
    speed: viz.warp.speed.toFixed(1), boost: viz.warp.boost.toFixed(2),
    kx: viz.warp.kx.toExponential(2), ky: viz.warp.ky.toExponential(2), energy: viz.warp.energy.toFixed(2),
    bands: (() => { const s = viz.audio.spectrum; const mean = (a, b) => { let m = 0; for (let i = a; i < b; i++) m += s[i]; return +(m / (b - a)).toFixed(2); }; return [mean(0, 14), mean(14, 36), mean(36, 76), mean(76, 128)]; })(),
  })`);
  console.log(label, info);
}
if (logs.length) console.log(logs.join('\n'));
ws.close();
chrome.kill();
process.exit(0);
