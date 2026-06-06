#!/usr/bin/env node
/**
 * triage.mjs — turn a fleet-QA results set into a per-app fix work-list.
 *
 * Reads a results.json (either the dashboard aggregate from GET /api/results.json
 * — rich rows with `node` + `backendHealthy` — or a node-local results.json — slim
 * rows), keeps only the ACTIONABLE apps, guesses a bug class, assigns each a node,
 * and prints a work-list the post-run agent fan-out consumes (one diagnose+fix+PR
 * subagent per row).
 *
 * "Actionable" = a real bug, not a provisioning artifact:
 *   • score === 'fail'                                   → never became ready (the bug)
 *   • score === 'warn' AND backend is down/degraded      → frontend serves, a dep crashed
 * NOT actionable (reported separately, never assigned):
 *   • warn with a healthy backend = missing-screenshot false-warn (no chromium on that node)
 *   • skip (no_gui / ghcr / gpu / vm) · pass
 *
 * Usage:
 *   node triage.mjs <results.json>          # print the work-list table
 *   node triage.mjs <results.json> --json   # also write worklist.json next to it
 *   curl -s localhost:4242/api/results.json > /tmp/r.json && node triage.mjs /tmp/r.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = JSON.parse(readFileSync(join(HERE, 'fleet.json'), 'utf-8'));
const PULL_READY = ['core-1', 'core-2', 'core-6', 'core-8', 'core-9', 'beta-1']; // nodes a fix agent can SSH+repro on

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const wantJson = args.includes('--json');
if (!path) {
  console.error('Usage: node triage.mjs <results.json> [--json]');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(path, 'utf-8'));
const rows = Array.isArray(raw) ? raw : Array.isArray(raw.results) ? raw.results : [];
if (!rows.length) {
  console.error(`No result rows in ${path}`);
  process.exit(1);
}

// Bug-class guess from notes/status — drawn from the known fix patterns (DB race, perms, secrets, mongo, port, pull).
function bugClass(r) {
  const n = `${r.notes ?? ''}`.toLowerCase();
  if (/password authentication failed/.test(n)) return 'db-auth: stale pgdata / wrong password';
  if (/econnrefused|connection refused|:5432|:3306|:27017/.test(n)) return 'db-race: app outran its DB → needs dependsOn service_healthy';
  if (/permission denied|eacces|mkdir|open .*denied/.test(n)) return 'perms: non-root UID vs bind-mount ownership';
  if (/server-121912|kernel|not supported on this platform/.test(n)) return 'mongo-kernel: mongo:8.0 on kernel≥6.19 → mongo:8.2.x';
  if (/mount .* onto|not a directory|is a directory/.test(n)) return 'compose: file-vs-dir bind mount (seed apps/<id>/data)';
  if (/manifest unknown|not found|pull|denied|unauthorized/.test(n)) return 'image-pull: bad tag / private image';
  if (/\${|placeholder|secret|env/.test(n)) return 'env: placeholder secret not substituted (VAR template left raw)';
  if (r.score === 'warn') return 'backend-degraded: a service is down/restarting (see notes)';
  return 'unknown: crashed/never-ready — diagnose on node';
}

// Normalize either result shape; backendHealthy may be absent in slim rows → infer from notes.
function norm(r, i) {
  const score = r.score ?? 'fail';
  const backendHealthy =
    typeof r.backendHealthy === 'boolean'
      ? r.backendHealthy
      : score === 'warn' && /backend|down|restart|crash|unhealthy|refused|denied|failed/i.test(`${r.notes ?? ''}`)
        ? false
        : undefined;
  return {
    appId: r.appId,
    score,
    httpStatus: r.httpStatus ?? r.http ?? null,
    backendHealthy,
    notes: `${r.notes ?? ''}`.slice(0, 160),
    node: r.node ?? null,
    i,
  };
}

const norms = rows.map(norm);
const actionable = norms.filter((r) => r.score === 'fail' || (r.score === 'warn' && r.backendHealthy === false));
const falseWarn = norms.filter((r) => r.score === 'warn' && r.backendHealthy !== false);
const skipped = norms.filter((r) => r.score === 'skip').length;
const passed = norms.filter((r) => r.score === 'pass').length;

// Assign each actionable app a node to diagnose on: prefer where it ran, else round-robin over pull-ready nodes.
const worklist = actionable.map((r, k) => {
  const node = r.node && PULL_READY.includes(r.node) ? r.node : PULL_READY[k % PULL_READY.length];
  const ip = FLEET.find((n) => n.name === node)?.ip ?? '';
  return {
    appId: r.appId,
    score: r.score,
    httpStatus: r.httpStatus,
    backendHealthy: r.backendHealthy,
    bugClass: bugClass(r),
    notes: r.notes,
    node,
    nodeIp: ip,
    localRepro: `node .claude/skills/run-fleet-qa/drive-qa.mjs --screenshot ${r.appId}`,
    nodeRepro: `ssh ci@${ip} 'APP_STORE_DIR=~/devel/CI-Marketplace/apps RESULTS_DIR=~/qa-wf SKIP_SCREENSHOT=1 ~/devel/CI-Hub/node_modules/.bin/tsx /tmp/qa-stream.ts ${r.appId}'`,
    manifest: `../CI-Marketplace/apps/${r.appId}/`,
  };
});

console.error(
  `\n  results: ${norms.length} apps — ${passed} pass, ${falseWarn.length} false-warn, ${actionable.length} ACTIONABLE, ${skipped} skip\n`,
);
console.error('  ── actionable (one diagnose+fix+PR agent each) ──');
for (const w of worklist) {
  console.error(
    `  ${String(w.score).toUpperCase().padEnd(4)} ${w.appId.padEnd(20)} @${w.node.padEnd(8)} http ${String(w.httpStatus ?? '-').padEnd(4)} ${w.bugClass}`,
  );
}
if (falseWarn.length) {
  console.error('\n  ── false-warn (missing screenshot only — NOT bugs; sync chromium to the node) ──');
  console.error(`  ${falseWarn.map((r) => r.appId).join(', ')}`);
}

if (wantJson) {
  const out = join(dirname(path), 'worklist.json');
  writeFileSync(out, JSON.stringify(worklist, null, 2));
  console.error(`\n  wrote ${out}  (${worklist.length} fix assignments)`);
}
console.error('');
