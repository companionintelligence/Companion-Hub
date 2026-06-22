#!/usr/bin/env node
/**
 * drive-qa.mjs — local driver for the CI-Hub fleet-QA bug detector.
 *
 * Wraps `scripts/qa-stream.ts` (the per-app harness that boots a CI-Marketplace
 * app's Docker container(s), waits for it to become healthy, screenshots it, and
 * scores it) so a future agent can run it against one app on a single machine —
 * no Tailscale fleet, no SSH. This is the layer that actually finds the bugs.
 *
 * Usage:
 *   node drive-qa.mjs <app-id> [app-id...]      # SKIP_SCREENSHOT by default → pass shows as warn
 *   node drive-qa.mjs --screenshot <app-id>     # also screenshot (auto-finds Google Chrome on macOS)
 *   node drive-qa.mjs --list                     # list available marketplace app ids
 *
 * Env overrides (all optional — sensible defaults are derived):
 *   APP_STORE_DIR        path to CI-Marketplace/apps   (default: sibling repo, then ~/devel/...)
 *   RESULTS_DIR          where results.json/screenshots land (default: a fresh temp dir)
 *   QA_READY_TIMEOUT_MS  per-app readiness ceiling      (default: 180000)
 *   QA_CHROMIUM_PATH     chromium/chrome binary for the screenshot step
 *
 * Exit code: 0 unless an app scored `fail` (skip/warn/pass all exit 0) — CI-friendly.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Skill lives at <CI-Hub>/.claude/skills/run-fleet-qa/ → CI-Hub root is three levels up.
const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = join(HUB_ROOT, 'node_modules/.bin/tsx');
const QA_STREAM = join(HUB_ROOT, 'scripts/qa-stream.ts');

function resolveAppStore() {
  if (process.env.APP_STORE_DIR) return process.env.APP_STORE_DIR;
  const candidates = [
    join(HUB_ROOT, '../CI-Marketplace/apps'),
    join(homedir(), 'devel/CI-Marketplace/apps'),
    join(homedir(), 'devel/CI-App-Store/apps'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function findChrome() {
  if (process.env.QA_CHROMIUM_PATH) return process.env.QA_CHROMIUM_PATH;
  const macs = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return macs.find(existsSync) ?? '';
}

const args = process.argv.slice(2);
const wantShot = args.includes('--screenshot');
const wantList = args.includes('--list');
const apps = args.filter((a) => !a.startsWith('--'));
const APP_STORE_DIR = resolveAppStore();

if (!existsSync(TSX)) {
  console.error(`tsx not found at ${TSX} — run \`pnpm install\` in ${HUB_ROOT} first.`);
  process.exit(1);
}
if (!existsSync(APP_STORE_DIR)) {
  console.error(`CI-Marketplace apps dir not found: ${APP_STORE_DIR}\nClone CI-Marketplace beside CI-Hub or set APP_STORE_DIR.`);
  process.exit(1);
}

if (wantList) {
  const ids = readdirSync(APP_STORE_DIR).filter((d) => existsSync(join(APP_STORE_DIR, d, 'config.json')));
  process.stdout.write(`${ids.length} apps in ${APP_STORE_DIR}:\n\n${ids.sort().join('\n')}\n`);
  process.exit(0);
}

if (apps.length === 0) {
  console.error('Usage: node drive-qa.mjs [--screenshot] <app-id> [app-id...]   (or --list)');
  process.exit(2);
}

const missing = apps.filter((a) => !existsSync(join(APP_STORE_DIR, a, 'config.json')));
if (missing.length) {
  console.error(`Unknown app id(s): ${missing.join(', ')}\nRun \`node drive-qa.mjs --list\` to see valid ids.`);
  process.exit(2);
}

const RESULTS_DIR = process.env.RESULTS_DIR ?? mkdtempSync(join(tmpdir(), 'qa-'));
const env = {
  ...process.env,
  APP_STORE_DIR,
  RESULTS_DIR,
  QA_READY_TIMEOUT_MS: process.env.QA_READY_TIMEOUT_MS ?? '180000',
};
if (wantShot) {
  const chrome = findChrome();
  if (chrome) env.QA_CHROMIUM_PATH = chrome;
  else console.error('⚠  --screenshot requested but no Chrome/Chromium found; set QA_CHROMIUM_PATH. Continuing without it.');
} else {
  env.SKIP_SCREENSHOT = '1';
}

console.error(`▶ qa-stream ${apps.join(' ')}`);
console.error(`  APP_STORE_DIR=${APP_STORE_DIR}`);
console.error(`  RESULTS_DIR=${RESULTS_DIR}`);
console.error(`  screenshot=${wantShot ? env.QA_CHROMIUM_PATH || 'unavailable' : 'skipped'}\n`);

const child = spawn(TSX, [QA_STREAM, ...apps], { cwd: HUB_ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });
const verdicts = [];

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  switch (o.event) {
    case 'app_phase':
      console.error(`  · ${o.appId} [${o.phase}] ${o.message}`);
      break;
    case 'app_result': {
      const r = o.result;
      verdicts.push(r);
      const flags = [
        `http ${r.httpStatus ?? '-'}`,
        `backend ${r.backendHealthy === undefined ? '-' : r.backendHealthy}`,
        r.readyVia ? `via ${r.readyVia}` : '',
      ]
        .filter(Boolean)
        .join('  ');
      console.error(`  ✓ ${o.appId}: ${String(r.score).toUpperCase()}  (${flags})${r.notes ? `  — ${r.notes}` : ''}`);
      break;
    }
  }
});

child.on('close', (code) => {
  const tally = {};
  for (const r of verdicts) tally[r.score] = (tally[r.score] ?? 0) + 1;
  console.error('\n── verdict ──');
  for (const r of verdicts) console.error(`  ${String(r.score).padEnd(5)} ${r.appId}`);
  console.error(
    `  totals: ${
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ') || 'none'
    }`,
  );
  console.error(`  results.json: ${join(RESULTS_DIR, 'results.json')}`);
  const failed = verdicts.filter((r) => r.score === 'fail').length;
  if (code !== 0 && verdicts.length === 0) process.exit(code ?? 1); // harness crashed before any result
  process.exit(failed > 0 ? 1 : 0);
});
