// Record "open a docs page, jump to a section, copy a command" at real speed.
//
// Frame-stepped: every frame's state (cursor, typed URL, scroll) is computed from
// a timeline, applied, and screenshotted, then piped to ffmpeg at 30 fps. The
// page itself is the live site, shown in a plain browser window.
//
//   node record_website.mjs <site> out.mp4 [stillsDir]     site: docker-apt | ci-engine | ci-hub-install | hub-dashboard
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const SITES = {
  // docs.docker.com: Ubuntu apt-repository steps (Alpine.js copy button, OneTrust banner, promo strip).
  'docker-apt': {
    typed: 'docs.docker.com/engine/install/ubuntu',
    page: 'https://docs.docker.com/engine/install/ubuntu/',
    anchor: 'install-using-the-repository',
    block: /^# Add Docker's official GPG key/,
    copyButton: 'button[title="copy"]',
    block3p: /onetrust|cookielaw|googletagmanager|google-analytics|segment\.(io|com)|hotjar|clarity\.ms|doubleclick/,
    css: '#onetrust-consent-sdk{display:none!important}',
    promo: /Cloud Sandboxes/,
    stills: ['docs-page-top', 'docs-apt-section', 'docs-copied'],
  },
  // docs.ci.computer: Install Docker -> Docker Engine (Linux) (Nextra copy button).
  'ci-engine': {
    typed: 'docs.ci.computer/docs/getting-started/installing-docker',
    page: 'https://docs.ci.computer/docs/getting-started/installing-docker',
    anchor: 'install-docker-engine-linux',
    block: /^curl -fsSL https:\/\/get\.docker\.com \| sh$/,
    copyButton: 'button[title="Copy code"], button[aria-label="Copy code"]',
    block3p: /cloudflareinsights|googletagmanager|google-analytics|plausible|posthog/,
    css: '',
    promo: null,
    stills: ['ci-docs-page-top', 'ci-docs-engine-section', 'ci-docs-copied'],
  },
  // docs.ci.computer: Installation -> Option 2: Linux server (headless). Hover the block, no copy:
  // Docker is already installed, so the terminal runs only the Hub lines.
  'ci-hub-install': {
    typed: 'docs.ci.computer/docs/getting-started/installation',
    page: 'https://docs.ci.computer/docs/getting-started/installation',
    anchor: 'option-2-linux-server-headless',
    block: /^# Install Docker \(if not present\)/,
    copyButton: 'button[title="Copy code"], button[aria-label="Copy code"]',
    copy: false,
    block3p: /cloudflareinsights|googletagmanager|google-analytics|plausible|posthog/,
    css: '',
    promo: null,
    stills: ['hub-docs-page-top', 'hub-docs-option-2', 'hub-docs-option-2-block'],
  },
  // The Hub dashboard inside the recording VM (its :5002, forwarded to 127.0.0.1:15002).
  'hub-dashboard': {
    typed: 'localhost:5002',
    page: 'http://127.0.0.1:15002/',
    display: { host: 'localhost:5002', path: '/device-registration', secure: false },
    visit: true,
    block3p: /cloudflareinsights|googletagmanager|google-analytics|plausible|posthog/,
    css: '',
    promo: null,
    stills: ['hub-dashboard'],
  },
};
const SITE = SITES[process.argv[2]];
if (!SITE) throw new Error(`usage: record_website.mjs <${Object.keys(SITES).join('|')}> out.mp4 [stillsDir]`);
const OUT = process.argv[3] ?? 'website.mp4';
const STILLS = process.argv[4];
const FPS = 30, W = 1920, H = 1080;
const ZOOM = 1.2, CHROME_H = 92;
const VW = Math.round(W / ZOOM), VH = Math.round((H - CHROME_H) / ZOOM);
const URL_TYPED = SITE.typed, PAGE = SITE.page, ANCHOR = SITE.anchor;
const HOST = SITE.display?.host ?? new URL(PAGE).host, PATHNAME = SITE.display?.path ?? new URL(PAGE).pathname;

// deterministic human typing
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const typeTimes = (text, t0) => {
  const ts = []; let t = t0;
  for (const ch of text) { ts.push(t); t += 0.07 + rnd() * 0.1 + (ch === '.' || ch === '/' ? rnd() * 0.18 : 0) + (rnd() < 0.04 ? 0.35 : 0); }
  return { ts, end: t };
};
const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

const harness = `<!doctype html><html><head><style>
*{box-sizing:border-box} html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:"Ubuntu","Cantarell",system-ui,sans-serif;background:#f9f9fb}
#tabs{height:44px;background:#e8e8ed;display:flex;align-items:flex-end;padding:0 12px;gap:8px}
.tab{height:36px;width:300px;background:#f9f9fb;border-radius:10px 10px 0 0;display:flex;align-items:center;gap:10px;padding:0 14px;font-size:15px;color:#1c1b22;white-space:nowrap;overflow:hidden}
.tab img{width:18px;height:18px} .tab .x{margin-left:auto;color:#5b5b66;font-size:16px}
.plus{height:36px;width:36px;display:grid;place-items:center;color:#5b5b66;font-size:22px}
#bar{height:48px;display:flex;align-items:center;gap:14px;padding:0 14px;border-bottom:1px solid #d7d7db;background:#f9f9fb}
.nav{color:#5b5b66;font-size:20px;width:22px;text-align:center}
#url{flex:1;height:36px;border-radius:8px;background:#f0f0f4;display:flex;align-items:center;padding:0 14px;gap:10px;font-size:16px;color:#1c1b22;border:2px solid transparent}
#url.focus{background:#fff;border-color:#0061e0}
#lock{width:14px;height:14px;display:none} #url.loaded #lock{display:block} #url.insecure #lock{display:none}
#ph{color:#6f6f78} #caret{display:inline-block;width:1.5px;height:20px;background:#1c1b22;vertical-align:middle;margin-left:1px}
#host{color:#1c1b22} #rest{color:#6f6f78}
#content{position:absolute;top:${CHROME_H}px;left:0;width:${W}px;height:${H - CHROME_H}px;overflow:hidden;background:#f9f9fb}
#newtab{position:absolute;inset:0;display:grid;place-items:center;color:#8f8f9d;font-size:18px}
#frame{position:absolute;top:0;left:0;width:${VW}px;height:${VH}px;border:0;transform:scale(${ZOOM});transform-origin:0 0;visibility:hidden;background:#fff}
#progress{position:absolute;top:${CHROME_H - 2}px;left:0;height:3px;background:#0061e0;width:0}
#cursor{position:absolute;left:0;top:0;width:28px;height:28px;pointer-events:none;z-index:9}
#cursor svg{position:absolute;left:0;top:0} #ripple{position:absolute;width:36px;height:36px;border-radius:50%;border:3px solid #0a6358;opacity:0;pointer-events:none;z-index:8}
</style></head><body>
<div id="tabs"><div class="tab"><img id="fav" style="visibility:hidden" onerror="this.dataset.bad=1;this.style.visibility='hidden'"><span id="title">New Tab</span><span class="x">×</span></div><div class="plus">+</div></div>
<div id="bar"><span class="nav">←</span><span class="nav">→</span><span class="nav">↻</span>
<div id="url"><svg id="lock" viewBox="0 0 16 16"><path fill="#5b5b66" d="M4 7V5a4 4 0 0 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 0 0-4 0v2z"/></svg><span><span id="ph">Search or enter address</span><span id="host"></span><span id="rest"></span><span id="caret" style="visibility:hidden"></span></span></div></div>
<div id="progress"></div>
<div id="content"><div id="newtab">New Tab</div><iframe id="frame"></iframe></div>
<div id="ripple"></div>
<div id="cursor"><svg id="arrow" width="28" height="28" viewBox="0 0 28 28"><path d="M3 2 L3 22 L8.5 17 L12 25 L15.5 23.5 L12 15.5 L19.5 15.5 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>
<svg id="hand" width="28" height="28" viewBox="0 0 28 28" style="display:none"><path d="M10 3.5a1.8 1.8 0 0 1 3.6 0V12l1-.2a1.8 1.8 0 0 1 2.4 1.2l.9-.1a1.8 1.8 0 0 1 2.3 1.4l.6 0a1.8 1.8 0 0 1 2.1 1.8v4.3c0 3.2-2.4 6.1-6 6.1h-2.7c-2 0-3.3-.8-4.5-2.4L5 17.3a1.8 1.8 0 0 1 2.7-2.3L10 17.2z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round" transform="translate(-4 -1)"/></svg></div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://docs.docker.com' });
// Privacy: block consent/analytics scripts outright (no cookies accepted).
await ctx.route(SITE.block3p, r => r.abort());
// The docs send X-Frame-Options: DENY; drop it in this recording browser only.
await ctx.route(PAGE + '**', async route => {
  if (route.request().resourceType() !== 'document') return route.continue();
  const resp = await route.fetch();
  const headers = { ...resp.headers() };
  delete headers['x-frame-options']; delete headers['content-security-policy'];
  await route.fulfill({ response: resp, headers });
});
const page = await ctx.newPage();
await page.setContent(harness);
const $ = sel => page.locator(sel);

// Preload the docs page now so "loading" on screen takes a realistic, fixed time.
await page.evaluate(src => { document.getElementById('frame').src = src; }, PAGE);
let frame;
for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find(f => f.url().startsWith(PAGE)); if (!frame) await page.waitForTimeout(100); }
await frame.waitForLoadState('networkidle');
await frame.evaluate(({ css, promo }) => {
  const st = document.createElement('style');
  st.textContent = css + ' html{scroll-behavior:auto!important} ::-webkit-scrollbar{width:0}';
  document.head.appendChild(st);
  if (promo) {
    // Hide the promotional strip above the header (not part of the docs).
    const rx = new RegExp(promo);
    const hit = [...document.querySelectorAll('body *')].find(e => rx.test(e.textContent) && e.children.length < 6 && e.getBoundingClientRect().top < 50);
    let n = hit; while (n && n.parentElement && n.parentElement !== document.body && n.parentElement.getBoundingClientRect().height < 60) n = n.parentElement;
    if (n) n.style.display = 'none';
  }
  window.scrollTo(0, 0);
}, { css: SITE.css, promo: SITE.promo?.source ?? null });
await page.waitForTimeout(800);
const geo = SITE.visit ? await frame.evaluate(() => ({ title: document.title })) : await frame.evaluate(({ a, block, copyButton }) => {
  const r = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 + scrollY }; };
  const toc = [...document.querySelectorAll(`a[href="#${a}"]`)].find(x => x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().left > innerWidth * 0.6);
  const h = document.getElementById(a);
  const hy = h.getBoundingClientRect().top + scrollY;
  const rx = new RegExp(block);
  const pre = [...document.querySelectorAll('pre')].find(p => p.getBoundingClientRect().top + scrollY > hy && rx.test(p.textContent.trim()));
  let box = pre, btn = null;
  while (box && !(btn = box.querySelector(copyButton))) box = box.parentElement;
  const pr = pre.getBoundingClientRect();
  return { toc: r(toc), headY: hy, btn: r(btn), lines: { x: pr.left + pr.width * 0.38, y: pr.top + pr.height * 0.5 + scrollY }, title: document.title };
}, { a: ANCHOR, block: SITE.block?.source, copyButton: SITE.copyButton });
const fav = await frame.evaluate(() => new URL(document.querySelector('link[rel~="icon"]')?.getAttribute('href') || '/favicon.ico', location.href).href);
const scrollTarget = SITE.visit ? 0 : Math.round(geo.headY - 80);

// ---- timeline (seconds) ----
const toScreen = (x, y, scroll) => ({ x: x * ZOOM, y: CHROME_H + (y - scroll) * ZOOM });
const urlBox = { x: 520, y: 44 + 24 };
const T = {};
T.moveToBar = [0.6, 1.4];
T.clickBar = 1.45;
const typing = typeTimes(URL_TYPED, 1.9);
T.enter = typing.end + 0.45;
T.shown = T.enter + 1.15;                    // page painted
T.moveToToc = [T.shown + 2.4, T.shown + 3.3];
T.clickToc = T.moveToToc[1] + 0.25;
T.scroll = [T.clickToc + 0.05, T.clickToc + 0.95];
T.moveToBtn = [T.scroll[1] + 2.6, T.scroll[1] + 3.5];
T.clickBtn = T.moveToBtn[1] + 0.3;
T.end = T.clickBtn + 2.4;
const COPY = SITE.copy !== false && !SITE.visit;
if (SITE.copy === false) { T.clickBtn = Infinity; T.end = T.moveToBtn[1] + 2.8; }   // hover the block, no copy
if (SITE.visit) {                                                                    // open the URL and look
  T.moveAway = [T.shown + 0.4, T.shown + 1.4];
  for (const k of ['moveToToc', 'scroll', 'moveToBtn']) T[k] = [Infinity, Infinity];
  T.clickToc = T.clickBtn = Infinity;
  T.end = T.shown + 5.5;
}

const start = { x: 1180, y: 640 };
const tocS0 = SITE.visit ? start : toScreen(geo.toc.x, geo.toc.y, 0);
const btnS = SITE.visit ? start : SITE.copy === false ? toScreen(geo.lines.x, geo.lines.y, scrollTarget) : toScreen(geo.btn.x, geo.btn.y, scrollTarget);
const away = { x: 1720, y: 980 };   // empty corner: nothing under the pointer
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const seg = (t, [a, b]) => Math.min(1, Math.max(0, (t - a) / (b - a)));

function state(t) {
  let cur = start;
  if (t >= T.moveToBar[0]) cur = lerp(start, urlBox, ease(seg(t, T.moveToBar)));
  if (t >= T.moveToToc[0]) cur = lerp(urlBox, tocS0, ease(seg(t, T.moveToToc)));
  if (t >= T.moveToBtn[0]) cur = lerp(tocS0, btnS, ease(seg(t, T.moveToBtn)));
  if (T.moveAway && t >= T.moveAway[0]) cur = lerp(urlBox, away, ease(seg(t, T.moveAway)));
  const scroll = t < T.scroll[0] ? 0 : Math.round(scrollTarget * ease(seg(t, T.scroll)));
  const typed = t < typing.ts[0] ? 0 : typing.ts.filter(x => x <= t).length;
  const hand = (t >= T.moveToToc[1] - 0.15 && t < T.scroll[1]) || (SITE.copy !== false && t >= T.moveToBtn[1] - 0.15);
  const clicks = [T.clickBar, T.clickToc, T.clickBtn].filter(c => t >= c && t < c + 0.45).map(c => (t - c) / 0.45);
  return { cur, scroll, typed, hand, ripple: clicks[0] };
}

// ---- render ----
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.ceil(T.end * FPS);
let lastScroll = -1, phase = '';
const stills = Object.fromEntries(SITE.stills.map((n, i) => [n, (SITE.visit ? [T.shown + 3] : [T.shown + 1.5, T.scroll[1] + 1.5, COPY ? T.clickBtn + 0.6 : T.end - 0.5])[i]]));
for (let i = 0; i < frames; i++) {
  const t = i / FPS, s = state(t);
  const p = t < T.clickBar ? 'idle' : t < T.enter ? 'typing' : t < T.shown ? 'loading' : t < T.clickToc ? 'page' : 'anchor';
  await page.evaluate(({ s, t, p, typedText, T, title, fav, anchor, hostName, pathName, secure }) => {
    const c = document.getElementById('cursor'); c.style.transform = `translate(${s.cur.x}px,${s.cur.y}px)`;
    document.getElementById('arrow').style.display = s.hand ? 'none' : 'block';
    document.getElementById('hand').style.display = s.hand ? 'block' : 'none';
    const r = document.getElementById('ripple');
    if (s.ripple !== undefined) { r.style.opacity = String(0.7 * (1 - s.ripple)); const sz = 16 + 34 * s.ripple; r.style.width = r.style.height = sz + 'px'; r.style.left = (s.cur.x - sz / 2 + 3) + 'px'; r.style.top = (s.cur.y - sz / 2 + 3) + 'px'; } else r.style.opacity = '0';
    const url = document.getElementById('url'), ph = document.getElementById('ph'), host = document.getElementById('host'), rest = document.getElementById('rest'), caret = document.getElementById('caret');
    if (p === 'idle') { url.className = ''; }
    else if (p === 'typing') { url.className = 'focus'; ph.style.display = s.typed ? 'none' : 'inline'; host.textContent = typedText.slice(0, s.typed); rest.textContent = ''; caret.style.visibility = (Math.floor((t - T.clickBar) / 0.53) % 2 === 0 || s.typed > 0) ? 'visible' : 'hidden'; }
    else {
      url.className = p === 'loading' ? '' : (secure ? 'loaded' : 'loaded insecure'); ph.style.display = 'none'; caret.style.visibility = 'hidden';
      host.textContent = hostName; rest.textContent = pathName + (p === 'anchor' ? '#' + anchor : '');
    }
    const prog = document.getElementById('progress');
    if (p === 'loading') { const k = (t - T.enter) / (T.shown - T.enter); prog.style.width = (20 + 75 * Math.sqrt(k)) + '%'; prog.style.opacity = '1'; }
    else if (p === 'page' && t < T.shown + 0.25) { prog.style.width = '100%'; prog.style.opacity = String(1 - (t - T.shown) / 0.25); }
    else prog.style.opacity = '0';
    const shown = p === 'page' || p === 'anchor';
    document.getElementById('frame').style.visibility = shown ? 'visible' : 'hidden';
    document.getElementById('newtab').style.display = shown ? 'none' : 'grid';
    if (shown) { document.getElementById('title').textContent = title; const f = document.getElementById('fav'); if (!f.src) f.src = fav; f.style.visibility = f.dataset.bad ? 'hidden' : 'visible'; }
  }, { s, t, p, typedText: URL_TYPED, T, title: geo.title, fav, anchor: ANCHOR, hostName: HOST, pathName: PATHNAME, secure: SITE.display?.secure !== false });
  await page.mouse.move(s.cur.x + 4, s.cur.y + 3);
  if (s.scroll !== lastScroll) { await frame.evaluate(y => window.scrollTo(0, y), s.scroll); lastScroll = s.scroll; }
  if (p !== phase && p === 'anchor') { /* hover state on TOC link is cosmetic; skip */ }
  // Copy feedback runs on the site's own timers, which tick in wall-clock time —
  // not video time here. docs.docker.com: drive its Alpine state on the video clock.
  // Elsewhere: click for real, with long timers frozen so the check mark holds to the end.
  if (COPY && Math.abs(t - T.clickBtn) < 0.5 / FPS && !SITE.promo)
    await frame.evaluate(() => { const st = window.setTimeout; window.setTimeout = (fn, d, ...a) => (d >= 1000 ? 0 : st(fn, d, ...a)); });
  if (COPY && Math.abs(t - T.clickBtn) < 0.5 / FPS && !SITE.promo) await page.mouse.click(s.cur.x + 4, s.cur.y + 3);
  if (SITE.promo) for (const [at, v] of [[T.clickBtn, true], [T.clickBtn + 2.0, false]])
    if (Math.abs(t - at) < 0.5 / FPS) await frame.evaluate(({ v, sel }) => { const b = [...document.querySelectorAll(sel)].find(b => { const r = b.getBoundingClientRect(); return r.top > 0 && r.top < innerHeight; }); window.Alpine.$data(b).copying = v; }, { v, sel: SITE.copyButton });
  phase = p;
  const png = await page.screenshot({ type: 'png' });
  if (STILLS) for (const [name, at] of Object.entries(stills)) if (Math.abs(t - at) < 0.5 / FPS) fs.writeFileSync(`${STILLS}/${name}.png`, png);
  if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
console.log(`wrote ${OUT}: ${frames} frames, ${(frames / FPS).toFixed(1)}s`, JSON.stringify(T));
