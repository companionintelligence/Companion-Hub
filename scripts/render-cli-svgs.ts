#!/usr/bin/env tsx
/**
 * Render faithful terminal screenshots of the cihub CLI as SVGs.
 *
 * Real commands are captured live (FORCE_COLOR=1) and their ANSI output is
 * parsed into colour runs. Curated demo scenes (interactive wizard, multi-host
 * status, etc.) are authored with the same renderer so spacing stays uniform.
 *
 * Every glyph is pinned to a fixed monospace grid via textLength +
 * lengthAdjust="spacingAndGlyphs", so box-drawing borders line up with content
 * regardless of the viewer's font metrics.
 *
 * Usage:
 *   pnpm exec tsx scripts/render-cli-svgs.ts
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── grid + palette ────────────────────────────────────────────────────────────

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const FONT_SIZE = 15;
const CELL_W = 9; // monospace advance at 15px
const LINE_H = 21;
const PAD_X = 18;
const TITLEBAR = 36;
const PAD_TOP = 26; // gap below titlebar to first baseline
const PAD_BOTTOM = 16;
const COLS = 86; // captured at COLUMNS=86

const BG = '#0d1117';
const TITLEBAR_BG = '#161b22';

type ColorKey = 'fg' | 'dim' | 'green' | 'cyan' | 'yellow' | 'red' | 'magenta' | 'prompt' | 'blue';

const COLORS: Record<ColorKey, string> = {
  fg: '#c9d1d9',
  dim: '#6e7681',
  green: '#3fb950',
  cyan: '#39c5cf',
  yellow: '#d29922',
  red: '#f85149',
  magenta: '#bc8cff',
  prompt: '#56d364',
  blue: '#58a6ff',
};

type Seg = { t: string; c: ColorKey; b?: boolean };
type Line = Seg[];

// ── ANSI SGR parser ───────────────────────────────────────────────────────────

function ansiToLines(input: string): Line[] {
  const ESC = String.fromCharCode(27);
  const lines: Line[] = [];
  let color: ColorKey = 'fg';
  let bold = false;
  let dim = false;

  for (const raw of input.replace(/\r/g, '').split('\n')) {
    const segs: Line = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === ESC && raw[i + 1] === '[') {
        const end = raw.indexOf('m', i);
        if (end !== -1) {
          const codes = raw
            .slice(i + 2, end)
            .split(';')
            .map((n) => Number.parseInt(n || '0', 10));
          for (const code of codes) {
            if (code === 0) {
              color = 'fg';
              bold = false;
              dim = false;
            } else if (code === 1) bold = true;
            else if (code === 2) dim = true;
            else if (code === 31) color = 'red';
            else if (code === 32) color = 'green';
            else if (code === 33) color = 'yellow';
            else if (code === 34) color = 'blue';
            else if (code === 35) color = 'magenta';
            else if (code === 36) color = 'cyan';
            else if (code === 39) color = 'fg';
          }
          i = end + 1;
          continue;
        }
      }
      // accumulate a run of plain text under the current style
      let j = i;
      while (j < raw.length && !(raw[j] === ESC && raw[j + 1] === '[')) j += 1;
      const text = raw.slice(i, j);
      if (text.length > 0) {
        const c: ColorKey = dim ? 'dim' : color;
        const last = segs[segs.length - 1];
        if (last && last.c === c && last.b === bold) last.t += text;
        else segs.push({ t: text, c, b: bold });
      }
      i = j;
    }
    lines.push(segs);
  }
  // drop a single trailing empty line from command output
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

// ── SVG emit ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lineCols(line: Line): number {
  return line.reduce((n, s) => n + s.t.length, 0);
}

function renderSvg(name: string, label: string, lines: Line[]): string {
  const maxCols = Math.max(COLS, ...lines.map(lineCols));
  const width = PAD_X * 2 + maxCols * CELL_W;
  const height = TITLEBAR + PAD_TOP + lines.length * LINE_H + PAD_BOTTOM;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="cihub ${esc(label)}">`,
  );
  parts.push(`  <rect width="${width}" height="${height}" rx="12" fill="${BG}"/>`);
  parts.push(`  <rect x="0" y="0" width="${width}" height="${TITLEBAR}" rx="12" fill="${TITLEBAR_BG}"/>`);
  parts.push(`  <rect x="0" y="${TITLEBAR - 12}" width="${width}" height="12" fill="${TITLEBAR_BG}"/>`);
  parts.push(`  <circle cx="20" cy="18" r="6" fill="#ff5f57"/>`);
  parts.push(`  <circle cx="40" cy="18" r="6" fill="#febc2e"/>`);
  parts.push(`  <circle cx="60" cy="18" r="6" fill="#28c840"/>`);
  parts.push(`  <text x="${width / 2}" y="23" text-anchor="middle" fill="#8b949e" font-size="12" font-family='${FONT}'>${esc(label)}</text>`);
  parts.push(`  <g font-family='${FONT}' font-size="${FONT_SIZE}" xml:space="preserve">`);

  lines.forEach((line, row) => {
    const y = TITLEBAR + PAD_TOP + row * LINE_H;
    let col = 0;
    for (const seg of line) {
      // Tokenize into maximal non-space runs; spaces are pure grid gaps so they
      // never sit inside a textLength run (which would collapse/stretch them).
      const chars = [...seg.t];
      let k = 0;
      while (k < chars.length) {
        if (chars[k] === ' ') {
          col += 1;
          k += 1;
          continue;
        }
        let run = '';
        while (k < chars.length && chars[k] !== ' ') {
          run += chars[k];
          k += 1;
        }
        const x = PAD_X + col * CELL_W;
        const tl = [...run].length * CELL_W;
        const weight = seg.b ? ' font-weight="bold"' : '';
        parts.push(
          `    <text x="${x}" y="${y}" textLength="${tl}" lengthAdjust="spacingAndGlyphs" fill="${COLORS[seg.c]}"${weight}>${esc(run)}</text>`,
        );
        col += [...run].length;
      }
    }
  });

  parts.push('  </g>');
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

// ── scene helpers ─────────────────────────────────────────────────────────────

const OUT_DIR = join(process.cwd(), 'docs/images/cli');

function promptLine(cmd: string): Line {
  return [
    { t: '$ ', c: 'prompt' },
    { t: cmd, c: 'fg' },
  ];
}

function capture(cmd: string): Line[] {
  const argv = cmd.replace(/^cihub /, '').split(' ');
  const res = spawnSync('pnpm', ['exec', 'tsx', 'scripts/start.ts', ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '1', COLUMNS: String(COLS) },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return ansiToLines(out);
}

/** Build a scene: prompt line(s) + captured/authored body. */
function scene(name: string, label: string, body: Line[]): void {
  const svg = renderSvg(name, label, body);
  writeFileSync(join(OUT_DIR, `${name}.svg`), svg, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`  rendered ${name}.svg  (${body.length} lines)`);
}

// authored-line helpers ────────────────────────────────────────────────────────
const T = (t: string, c: ColorKey = 'fg', b = false): Seg => ({ t, c, b });
const EMPTY: Line = [];

/** A bordered box with the CLI's open-right style: top rule, indented body, bottom rule. */
function box(title: string, body: Line[], tone: ColorKey, width = 84): Line[] {
  const titleLen = title.length;
  const fill = Math.max(width - titleLen - 5, 1);
  const top: Line = [T(`┌─ ${title} ${'─'.repeat(fill)}┐`, tone)];
  const bottom: Line = [T(`└${'─'.repeat(width - 2)}┘`, tone)];
  const indented = body.map((l) => [T('  ', 'fg'), ...l]);
  return [top, ...indented, bottom];
}

// ── scenes ────────────────────────────────────────────────────────────────────

function bannerLines(): Line[] {
  return [[T('COMPANION HUB', 'green', true)], [T('ci.computer', 'green')]];
}

console.log('Rendering CLI SVGs…');

// 1. help (captured)
scene('help', 'cihub --help', [promptLine('cihub --help'), ...capture('cihub --help')]);

// 2. man (captured)
scene('man', 'cihub man', [promptLine('cihub man'), ...capture('cihub man')]);

// 3. config (captured)
scene('lifecycle', 'cihub config · up · shutdown', [
  promptLine('cihub config local'),
  ...capture('cihub config local'),
  EMPTY,
  promptLine('cihub up local --detached'),
  ...box('Starting hub', [[T('Environment: local')], [T('Mode: detached')], [T('Compose files: docker-compose.local.yml')]], 'green'),
  [T('▶ docker compose --env-file .env.local --project-name ci-hub -f docker-compose.local.yml up -d --build', 'dim')],
  [T('Hub stack started.')],
  EMPTY,
  promptLine('cihub shutdown local'),
  ...box('Shutting down hub', [[T('Environment: local')]], 'yellow'),
  [T('▶ docker compose --env-file .env.local --project-name ci-hub -f docker-compose.local.yml down', 'dim')],
  [T('Hub stack stopped.')],
]);

// 4. register (captured — real device id on this machine)
scene('register', 'cihub register local', [promptLine('cihub register local'), ...capture('cihub register local')]);

// 5. status (captured — real host state)
scene('status', 'cihub status local', [promptLine('cihub status local'), ...capture('cihub status local')]);

// 6. app status / list (captured)
scene('app-list', 'cihub app status · list', [
  promptLine('cihub app status'),
  ...capture('cihub app status'),
  EMPTY,
  promptLine('cihub app list'),
  ...capture('cihub app list'),
]);

// 7. setup (authored)
scene('setup', 'cihub setup local', [
  promptLine('cihub setup local'),
  [T('▶ tsx scripts/init-traefik.ts', 'dim')],
  [T('Traefik config initialized.')],
  [T('▶ tsx scripts/init-docker-config.ts', 'dim')],
  [T('Docker auth config initialized.')],
  ...box('Setup complete', [[T('Host assets prepared for local.')], [T('Next: cihub register local')]], 'green'),
]);

// 8. mcp (authored — captured setup/config/shutdown rendered uniformly)
scene('mcp', 'cihub mcp setup · config · shutdown', [
  promptLine('cihub mcp setup local'),
  ...box('MCP enabled', [[T('environment      local')], [T('mcp enabled      true')], [T('mcp api key      <set>')]], 'green'),
  EMPTY,
  promptLine('cihub mcp config local'),
  ...box(
    'CI-Hub configuration',
    [
      [T('environment      local')],
      [T('cloud url        https://hub.companionintelligence.com')],
      [T('compose profiles private-vpn')],
      [T('mcp enabled      true')],
      [T('mcp api key      <set>')],
    ],
    'cyan',
  ),
  EMPTY,
  promptLine('cihub mcp shutdown local'),
  ...box('MCP disabled', [[T('environment      local')], [T('mcp enabled      false')], [T('mcp api key      <set>')]], 'yellow'),
]);

// 9. models (authored demo with installed models)
scene('models', 'cihub models list · install', [
  promptLine('cihub models list'),
  ...box('Installed models', [[T('Container: ci-hub-ollama')]], 'cyan'),
  [T('▶ docker exec ci-hub-ollama ollama list', 'dim')],
  [T('NAME              ID            SIZE    MODIFIED')],
  [T('llama3:latest     365c0bd3c000  4.7 GB  2 days ago')],
  [T('mistral:latest    61e88e884507  4.1 GB  5 days ago')],
  [T('phi3:latest       4f2222927938  2.3 GB  1 week ago')],
  EMPTY,
  promptLine('cihub models install codestral'),
  ...box('Installing model', [[T('Pulling '), T('codestral', 'fg', true), T(' via Ollama — this may take a few minutes…')]], 'green'),
  [T('▶ docker exec -it ci-hub-ollama ollama pull codestral', 'dim')],
  [T('pulling manifest...')],
  [T('pulling d7b23a42b423... 100% ▕████████████████▏ 18.8 GB')],
  [T('success', 'green')],
]);

// 10. app-management (authored full lifecycle)
scene('app-management', 'cihub app add · inspect · logs · delete', [
  promptLine('cihub app add demo-app nginx:alpine --port 8080:80 --env MODE=demo'),
  ...box('Adding container app', [[T('name   demo-app')], [T('image  nginx:alpine')], [T('ports  8080:80')], [T('env    MODE=demo')]], 'green'),
  [T('▶ docker run -d --name demo-app -p 8080:80 -e MODE=demo nginx:alpine', 'dim')],
  [T('c0ffee1234567890')],
  EMPTY,
  promptLine('cihub app inspect demo-app'),
  ...box(
    'Inspect: demo-app',
    [[T('image   nginx:alpine')], [T('status  '), T('running', 'green')], [T('ports   8080 → 80/tcp')], [T('env     MODE=demo')]],
    'cyan',
  ),
  EMPTY,
  promptLine('cihub app logs demo-app --tail 3'),
  ...box('Container logs', [[T('Container: demo-app')], [T('Tail: 3 lines')]], 'cyan'),
  [T('▶ docker logs --tail 3 --timestamps demo-app', 'dim')],
  [T('2026-05-31T22:00:00Z nginx: worker process is running...')],
  EMPTY,
  promptLine('cihub app delete demo-app'),
  ...box('Container app lifecycle', [[T('Removing container: demo-app')]], 'yellow'),
  [T('▶ docker rm -f demo-app', 'dim')],
  [T('demo-app')],
]);

// 11. wizard (authored FTUE)
scene('wizard', 'cihub wizard', [
  promptLine('cihub wizard'),
  ...bannerLines(),
  EMPTY,
  ...box(
    'Setup Wizard',
    [
      [T('Goal  Launch, configure, and register your Hub in one guided flow.')],
      [T('Tip   Press Enter to accept the shown default for each prompt.')],
      [T('Docs  cihub man  ·  cihub --help')],
    ],
    'green',
  ),
  EMPTY,
  ...box(
    'First-time setup detected',
    [
      [T('No .env.local found — wizard will guide you through initial setup.')],
      [T('○ [1/6] Choose environment', 'dim')],
      [T('○ [2/6] Check prerequisites', 'dim')],
      [T('○ [3/6] Initialize host & Docker config', 'dim')],
      [T('○ [4/6] Register with CI Cloud', 'dim')],
      [T('○ [5/6] Start the Hub', 'dim')],
      [T('○ [6/6] Install initial model (optional)', 'dim')],
    ],
    'yellow',
  ),
  EMPTY,
  [T('● [1/6] Choose environment', 'cyan')],
  ...box(
    'Choose environment',
    [
      [T('1. local    — Local Docker compose stack  (default)')],
      [T('2. dev      — Shared dev environment')],
      [T('3. staging  — Shared staging environment')],
      [T('4. prod     — Production environment')],
    ],
    'cyan',
  ),
  [T('  Environment [1-4, default 1]: '), T('1', 'prompt')],
  [T('✓ [1/6] Environment: local', 'green')],
  EMPTY,
  [T('● [2/6] Checking prerequisites…', 'cyan')],
  ...box(
    'Prerequisites',
    [
      [T('Docker:           '), T('● available', 'green')],
      [T('Docker Compose:   '), T('● available', 'green')],
      [T('Tailscale VPN:    '), T('● 100.64.0.3', 'green')],
      [T('Env file:         '), T('○ will be created', 'yellow')],
    ],
    'cyan',
  ),
  [T('✓ [2/6] Prerequisites checked', 'green')],
  EMPTY,
  [T('● [3/6] → ✓ [4/6] → ✓ [5/6] Hub launched → [6/6] Model install (optional)', 'dim')],
]);

// 12. banner-help (zoomed banner)
scene('banner-help', 'cihub --help', [
  promptLine('cihub --help'),
  ...bannerLines(),
  EMPTY,
  [T('The COMPANION HUB banner appears at the top of every command.', 'fg')],
  [T('wizard · status · models · app lifecycle · MCP · Cloudflare · Tailscale', 'dim')],
]);

// 13. banner-wizard (zoomed banner)
scene('banner-wizard', 'cihub wizard', [
  promptLine('cihub wizard'),
  ...bannerLines(),
  EMPTY,
  [T('The banner appears before every wizard prompt.', 'fg')],
  [T('6-step FTUE · prerequisites · setup · register · start · model install', 'dim')],
]);

console.log('Done.');
