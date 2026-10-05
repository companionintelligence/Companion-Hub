// Replay an asciicast v2 recording in an Ubuntu-style terminal window, frame by
// frame at its real timing, and encode it at 30 fps.
//
//   node render_terminal.mjs install.cast terminal.mp4 [stillsDir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [CAST, OUT = 'terminal.mp4', STILLS] = process.argv.slice(2);
const FPS = 30, W = 1920, H = 1080;
const lines = fs.readFileSync(CAST, 'utf8').trim().split('\n');
const header = JSON.parse(lines[0]);
const events = lines.slice(1).map(l => JSON.parse(l)).filter(e => e[1] === 'o');
const end = events.at(-1)[0];
const here = path.dirname(new URL(import.meta.url).pathname);
const xtermJs = fs.readFileSync(path.join(here, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = fs.readFileSync(path.join(here, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Ubuntu+Mono:wght@400;700&family=Ubuntu:wght@500&display=block">
<style>${xtermCss}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{background:linear-gradient(135deg,#0a6358 0%,#0e4a52 55%,#041620 100%);display:flex;justify-content:center;align-items:flex-start;padding-top:44px;box-sizing:border-box}
#win{border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.08);background:#1e1e1e}
#head{height:46px;background:#2b2b2b;display:flex;align-items:center;justify-content:center;position:relative;color:#e8e8e8;font:500 16px "Ubuntu",system-ui,sans-serif}
#dots{position:absolute;right:14px;display:flex;gap:10px}#dots span{width:16px;height:16px;border-radius:50%;background:#444}
#term{padding:14px 18px 18px}
.xterm-viewport{overflow:hidden!important}
</style></head><body><div id="win"><div id="head">ci@ubuntu: ~<div id="dots"><span></span><span></span><span></span></div></div><div id="term"></div></div>
<script>${xtermJs}</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(async ({ cols, rows }) => {
  await document.fonts.load('32px "Ubuntu Mono"');
  window.term = new Terminal({
    cols, rows, fontFamily: '"Ubuntu Mono", monospace', fontSize: 26, lineHeight: 1.05,
    cursorBlink: false, cursorStyle: 'block', allowTransparency: false, scrollback: 0,
    theme: {
      background: '#1e1e1e', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#1e1e1e',
      black: '#171421', red: '#c01c28', green: '#26a269', yellow: '#a2734c', blue: '#12488b', magenta: '#a347ba', cyan: '#2aa1b3', white: '#d0cfcc',
      brightBlack: '#5e5c64', brightRed: '#f66151', brightGreen: '#33da7a', brightYellow: '#e9ad0c', brightBlue: '#2a7bde', brightMagenta: '#c061cb', brightCyan: '#33c7de', brightWhite: '#ffffff',
    },
  });
  term.open(document.getElementById('term'));
  term.focus();
  window.feed = s => new Promise(r => term.write(s, () => requestAnimationFrame(() => requestAnimationFrame(r))));
}, { cols: header.width, rows: header.height });

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });

// Stills: the frame just before the prompt returns after each milestone.
const stillAt = {};
if (STILLS) {
  const find = (re, after = 0) => events.find(e => e[0] > after && re.test(e[2]))?.[0];
  const pw = find(/\[sudo\] password/);
  const y = find(/\[Y\/n\]/);
  const hello = find(/Hello from Docker!/);
  if (pw) stillAt['terminal-sudo-password'] = pw + 1.2;
  if (y) stillAt['terminal-apt-install-confirm'] = y + 1.0;
  if (hello) stillAt['terminal-hello-world'] = end - 0.5;
}

const frames = Math.ceil((end + 3.0) * FPS);  // asciicast omits the idle tail; hold the result
let k = 0, last;
for (let i = 0; i < frames; i++) {
  const t = i / FPS;
  let chunk = '';
  while (k < events.length && events[k][0] <= t) chunk += events[k++][2];
  if (chunk || !last) {
    if (chunk) await page.evaluate(s => feed(s), chunk);
    last = await page.screenshot({ type: 'png' });
  }
  if (STILLS) for (const [name, at] of Object.entries(stillAt)) if (Math.abs(t - at) < 0.5 / FPS) fs.writeFileSync(`${STILLS}/${name}.png`, last);
  if (!ff.stdin.write(last)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % 600 === 0) process.stderr.write(`  ${t.toFixed(0)}s / ${end.toFixed(0)}s\n`);
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
console.log(`wrote ${OUT}: ${frames} frames, ${(frames / FPS).toFixed(1)}s`);
