// Drive headless Chrome over the DevTools protocol.
//   node render.mjs frames <url> <outDir> <fps> <duration> [w h scale]   → outDir/f00000.png …  (calls window.render(t))
//   node render.mjs shot   <url> <out.png> <waitMs> [w h scale] [js]       → one screenshot after waitMs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const argv = process.argv.slice(2);
const [mode, url, out] = argv;
const [a, b, W = '1280', H = '720', S = '1.5', js] = mode === 'frames' ? argv.slice(3) : [argv[3], null, ...argv.slice(4)];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const prof = `${process.env.TMPDIR || '/tmp'}/cdp-${port}`;
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--hide-scrollbars', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) { chrome.kill(); throw new Error('chrome did not start'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m.method);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: +S, mobile: false });
await send('Page.navigate', { url });
for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); i++) await sleep(100);
await evalJs('document.fonts.ready.then(() => true)');
await sleep(400);

const shot = async (file) => writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

if (mode === 'frames') {
  const fps = +a, duration = +b;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const n = Math.round(fps * duration);
  for (let f = 0; f < n; f++) {
    await evalJs(`window.render(${f / fps}); true`);
    await shot(`${out}/f${String(f).padStart(5, '0')}.png`);
    if (f % 60 === 0) process.stderr.write(`frame ${f}/${n}\n`);
  }
} else {
  if (js) await evalJs(js);
  await sleep(+a);
  await shot(out);
}
ws.close();
chrome.kill();
await sleep(500);
try { rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);
