#!/usr/bin/env node
/**
 * distribute-hub.mjs — bring CI-Hub up to date on every fleet node.
 *
 * "Distribute updated Hub to all fleet computers" = get each node's
 * ~/devel/CI-Hub onto origin/dev's tip over Tailscale SSH. qa-stream.ts is SCP'd
 * per run by the dashboard, but the node's tsx/node_modules and any non-SCP'd
 * code come from this checkout, so it must track dev before a run.
 *
 * THE FLEET IS SPLIT (verified 2026-06-05):
 *   • git-auth nodes (core-1/2/6/beta-1 HTTPS-creds, core-8/9 deploy-key) → `git pull` works.
 *   • no-auth nodes (core-10/14/17/beta-ms-a2, tar-provisioned) → `git pull` FAILS
 *     ("could not read Username for github.com"). They need a tar-sync from an authed peer.
 * Nodes also sit in DETACHED HEAD — the execute path `git checkout dev` re-attaches them.
 *
 * SAFE BY DEFAULT — dry-run only reports state and changes nothing.
 *
 * Usage:
 *   node distribute-hub.mjs                       # dry-run: classify every node (read-only)
 *   node distribute-hub.mjs --execute             # git-pull the authed nodes to dev
 *   node distribute-hub.mjs --execute --tar-from core-1   # ...then tar-sync the no-auth nodes from core-1
 *   node distribute-hub.mjs --execute --only core-1,core-2
 *
 * Env: FLEET_SSH_USER (default ci) · FLEET_JSON (default ./fleet.json) · REPO_DIR (default ~/devel/CI-Hub)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SSH_USER = process.env.FLEET_SSH_USER ?? 'ci';
const REPO_DIR = process.env.REPO_DIR ?? '~/devel/CI-Hub';
const FLEET = JSON.parse(readFileSync(process.env.FLEET_JSON ?? join(HERE, 'fleet.json'), 'utf-8'));

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const tarFrom = arg('--tar-from');
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const nodes = FLEET.filter((n) => !only || only.has(n.name));
const SSH_OPTS = ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

// Report (dry-run): fetch is the auth probe — capture its exit explicitly, don't mask it.
const REPORT =
  `cd ${REPO_DIR} 2>/dev/null || { echo "state=norepo"; exit 0; }; ` +
  'if git fetch -q origin dev 2>/dev/null; then ' +
  `echo "auth=ok head=$(git rev-parse --short HEAD) behind=$(git rev-list --count HEAD..origin/dev 2>/dev/null) dirty=$(git status --porcelain|wc -l|tr -d ' ')"; ` +
  `else echo "auth=FAIL head=$(git rev-parse --short HEAD) dirty=$(git status --porcelain|wc -l|tr -d ' ')"; fi`;
// Execute: re-attach to dev and fast-forward. Fails loudly on a no-auth node (caught → tar fallback).
const PULL =
  `cd ${REPO_DIR} && git fetch origin dev && git checkout -q dev && ` +
  `git pull --ff-only origin dev && echo "updated head=$(git rev-parse --short HEAD)"`;

function ssh(ip, remote) {
  return new Promise((resolve) => {
    const p = spawn('ssh', [...SSH_OPTS, `${SSH_USER}@${ip}`, remote], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    p.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
  });
}

// Pipe `tar c` from a source node straight into `tar x` on a dest node (no -n on the receiver).
function tarSync(srcIp, dstIp) {
  const cmd =
    `ssh ${SSH_OPTS.join(' ')} ${SSH_USER}@${srcIp} 'tar czf - -C ~/devel CI-Hub' | ` +
    `ssh ${SSH_OPTS.join(' ')} ${SSH_USER}@${dstIp} 'tar xzf - -C ~/devel'`;
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, err: err.trim() }));
  });
}

console.error(`${EXECUTE ? '⟳ EXECUTE' : '· DRY-RUN'} CI-Hub@dev on ${nodes.length} node(s) as ${SSH_USER}@…\n`);

if (!EXECUTE) {
  const rows = await Promise.all(nodes.map(async (n) => ({ n, r: await ssh(n.ip, REPORT) })));
  let auth = 0;
  let noauth = 0;
  let down = 0;
  for (const { n, r } of rows) {
    const name = n.name.padEnd(11);
    if (r.code !== 0) {
      down++;
      console.error(`  ✗ ${name} UNREACHABLE — ${(r.err || `exit ${r.code}`).split('\n')[0].slice(0, 80)}`);
      continue;
    }
    if (r.out.includes('auth=ok')) {
      auth++;
      console.error(`  ✓ ${name} pull-ready   ${r.out}`);
    } else if (r.out.includes('auth=FAIL')) {
      noauth++;
      console.error(`  ⚠ ${name} NO GIT AUTH  ${r.out}  → needs --tar-from`);
    } else {
      console.error(`  ? ${name} ${r.out}`);
    }
  }
  console.error(
    `\n  ${auth} pull-ready, ${noauth} need tar-sync, ${down} down.  Re-run with --execute (add --tar-from <authed-node> to cover the no-auth nodes).`,
  );
  process.exit(0);
}

// EXECUTE — phase 1: git pull every node in parallel; split by outcome.
const pulled = await Promise.all(nodes.map(async (n) => ({ n, r: await ssh(n.ip, PULL) })));
const failed = [];
for (const { n, r } of pulled) {
  const name = n.name.padEnd(11);
  if (r.code === 0) console.error(`  ✓ ${name} ${r.out}`);
  else {
    failed.push(n);
    console.error(`  ⚠ ${name} git pull failed — ${(r.err || `exit ${r.code}`).split('\n').pop().slice(0, 80)}`);
  }
}

// Phase 2: tar-sync the git-pull failures from an authed source node.
if (failed.length && tarFrom) {
  const src = FLEET.find((n) => n.name === tarFrom);
  if (!src) {
    console.error(`\n  --tar-from ${tarFrom}: unknown node`);
    process.exit(1);
  }
  console.error(`\n  tar-syncing ${failed.length} node(s) from ${src.name}…`);
  for (const dst of failed) {
    const r = await tarSync(src.ip, dst.ip);
    const msg = r.code === 0 ? `tar-synced from ${src.name}` : (r.err.split('\n').pop() || 'tar failed').slice(0, 80);
    console.error(`  ${r.code === 0 ? '✓' : '✗'} ${dst.name.padEnd(11)} ${msg}`);
  }
} else if (failed.length) {
  console.error(`\n  ${failed.length} node(s) need a tar-sync (no git auth): ${failed.map((n) => n.name).join(', ')}`);
  console.error('  Re-run with --tar-from <authed-node>, e.g.  node distribute-hub.mjs --execute --tar-from core-1');
}
process.exit(failed.length && !tarFrom ? 1 : 0);
