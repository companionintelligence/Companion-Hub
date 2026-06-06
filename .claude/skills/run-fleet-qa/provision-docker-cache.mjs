#!/usr/bin/env node
/**
 * provision-docker-cache.mjs — make the Docker Hub pull-through cache survive node re-provisioning.
 *
 * Full fleet runs were scoring ~30 `error` verdicts from Docker Hub's UNAUTHENTICATED pull-rate
 * limit ("You have reached your unauthenticated pull rate limit") — NOT app bugs. All 10 nodes share
 * one public IP, so they share one anon bucket. The fix is two-sided and must be CODIFIED so a
 * re-provisioned node doesn't silently fall back to pulling direct from Hub:
 *
 *   1. Every node's /etc/docker/daemon.json points `registry-mirrors` at the cache on the cache node
 *      (core-1) — http://<cache-ip>:5050 — and lists it under `insecure-registries` (plain HTTP).
 *      Then every docker.io pull fleet-wide routes through one warm cache instead of hitting Hub.
 *   2. The cache itself (a `registry:2` pull-through running on the cache node) authenticates UPSTREAM
 *      with REGISTRY_PROXY_USERNAME/PASSWORD, so a cache-miss pull uses Hub's far higher AUTHENTICATED
 *      limit instead of the anon-per-IP one. Without creds the cache still throttles on every miss.
 *
 * SAFE BY DEFAULT — `--check` (the default) only reads `docker info` / `docker inspect` and asserts
 * the config, exiting non-zero if any node is mis-wired. `--execute` is required to mutate, and the
 * cache recreate needs creds in the env (it never hardcodes them).
 *
 * Usage:
 *   node provision-docker-cache.mjs                       # CHECK (read-only): assert mirror + authed cache fleet-wide
 *   node provision-docker-cache.mjs --execute             # apply the mirror to every node (sudo) + recreate the authed cache
 *   node provision-docker-cache.mjs --execute --only core-10,beta-1   # scope to specific nodes
 *   node provision-docker-cache.mjs --execute --no-cache  # only wire the mirrors, don't touch the cache container
 *
 * Env:
 *   FLEET_SSH_USER          ssh user (default ci)
 *   FLEET_JSON              path to fleet.json (default ./fleet.json next to this script)
 *   CACHE_NODE              name of the node running the registry:2 cache (default core-1)
 *   CACHE_PORT              cache published port (default 5050)
 *   REGISTRY_PROXY_USERNAME / REGISTRY_PROXY_PASSWORD   Docker Hub creds for the cache's authed upstream
 *                           (DOCKERHUB_USER / DOCKERHUB_PASS also accepted) — required for --execute unless --no-cache
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SSH_USER = process.env.FLEET_SSH_USER ?? 'ci';
const FLEET = JSON.parse(readFileSync(process.env.FLEET_JSON ?? join(HERE, 'fleet.json'), 'utf-8'));
const CACHE_NODE = process.env.CACHE_NODE ?? 'core-1';
const CACHE_PORT = process.env.CACHE_PORT ?? '5050';
const PROXY_USER = process.env.REGISTRY_PROXY_USERNAME ?? process.env.DOCKERHUB_USER ?? '';
const PROXY_PASS = process.env.REGISTRY_PROXY_PASSWORD ?? process.env.DOCKERHUB_PASS ?? '';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const NO_CACHE = args.includes('--no-cache');
const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const nodes = FLEET.filter((n) => !only || only.has(n.name));
const SSH_OPTS = ['-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

const cacheNode = FLEET.find((n) => n.name === CACHE_NODE);
if (!cacheNode) {
  console.error(`CACHE_NODE=${CACHE_NODE} not found in fleet.json — set CACHE_NODE to a node in the fleet.`);
  process.exit(2);
}
const MIRROR_URL = `http://${cacheNode.ip}:${CACHE_PORT}`;
const MIRROR_HOSTPORT = `${cacheNode.ip}:${CACHE_PORT}`;

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

// kv("a=1\nb=2") => { a: "1", b: "2" } — parse the `key=value` lines our remote snippets echo.
function kv(text) {
  const o = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

// ── Remote snippets ──────────────────────────────────────────────────────────

// Read-only probe of one node: is the mirror wired, and (on the cache node) is the cache authed?
function probeCmd(isCacheNode) {
  let s =
    `MIR=$(docker info 2>/dev/null | awk '/Registry Mirrors:/{f=1;next} f&&/^  /{print $1;next} {f=0}' | tr '\\n' ' '); ` +
    `echo "mirrors=$MIR"; ` +
    `echo "insecure=$(docker info 2>/dev/null | awk '/Insecure Registries:/{f=1;next} f&&/^  /{print $1;next} {f=0}' | tr '\\n' ' ')"`;
  if (isCacheNode) {
    s +=
      `; CID=$(docker ps -a --filter name=registry --format '{{.ID}}' | head -1); ` +
      `echo "cache_running=$(docker inspect -f '{{.State.Running}}' $CID 2>/dev/null)"; ` +
      `echo "cache_authed=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $CID 2>/dev/null | grep -c '^REGISTRY_PROXY_USERNAME=..*')"; ` +
      `echo "cache_remote=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $CID 2>/dev/null | grep '^REGISTRY_PROXY_REMOTEURL=' | head -1 | cut -d= -f2-)"`;
  }
  return s;
}

// Merge the mirror + insecure-registry into /etc/docker/daemon.json (preserving any other keys) and
// restart docker. The merge runs in python3 (on every Ubuntu node); base64 avoids all ssh quoting.
function mirrorCmd() {
  const py = [
    'import json,sys',
    'mirror,insec=sys.argv[1],sys.argv[2]',
    'p="/etc/docker/daemon.json"',
    'try:\n d=json.load(open(p))\nexcept Exception:\n d={}',
    'm=d.get("registry-mirrors") or []',
    'i=d.get("insecure-registries") or []',
    'if mirror not in m: m.append(mirror)',
    'if insec not in i: i.append(insec)',
    'd["registry-mirrors"]=m; d["insecure-registries"]=i',
    'sys.stdout.write(json.dumps(d,indent=2))',
  ].join('\n');
  const b64 = Buffer.from(py).toString('base64');
  return (
    `echo ${b64} | base64 -d | python3 - '${MIRROR_URL}' '${MIRROR_HOSTPORT}' | sudo tee /etc/docker/daemon.json >/dev/null && ` +
    'sudo systemctl restart docker && sleep 2 && ' +
    `docker info 2>/dev/null | awk '/Registry Mirrors:/{f=1;next} f&&/^  /{print "ok_mirror="$1;next} {f=0}' | head -1`
  );
}

// Recreate the registry:2 pull-through cache with authed upstream, PRESERVING its existing data volume
// (the ~49 GB warm cache) and published port. Creds come from a root-only env file (--env-file) so
// they don't sit in the container's argv / `docker inspect` for any user to read.
function cacheCmd() {
  const envfile = '/etc/docker/registry-cache.env';
  const envContent = `REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io\nREGISTRY_PROXY_USERNAME=${PROXY_USER}\nREGISTRY_PROXY_PASSWORD=${PROXY_PASS}\n`;
  const b64 = Buffer.from(envContent).toString('base64');
  return (
    // Discover the current cache container's data volume so we reuse it (keep the warm 49 GB).
    `CID=$(docker ps -a --filter name=registry --format '{{.ID}}' | head -1); ` +
    `VOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/registry"}}{{.Name}}{{end}}{{end}}' $CID 2>/dev/null); ` +
    `[ -z "$VOL" ] && VOL=registry-cache; ` +
    `echo "reuse_volume=$VOL"; ` +
    // Write the creds env file (root 0600), recreate the container pointed at the preserved volume.
    `echo ${b64} | base64 -d | sudo tee ${envfile} >/dev/null && sudo chmod 600 ${envfile} && ` +
    'docker rm -f registry-cache 2>/dev/null; docker rm -f $CID 2>/dev/null; ' +
    `docker run -d --restart always --name registry-cache -p ${CACHE_PORT}:5000 ` +
    `-v "$VOL":/var/lib/registry --env-file ${envfile} registry:2 >/dev/null && ` +
    `sleep 2 && echo "cache_authed=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' registry-cache | grep -c '^REGISTRY_PROXY_USERNAME=..*')"`
  );
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.error(
  `${EXECUTE ? '⟳ EXECUTE' : '· CHECK (read-only)'} docker-cache on ${nodes.length} node(s) — mirror=${MIRROR_URL} cache-node=${CACHE_NODE}\n`,
);

if (!EXECUTE) {
  // CHECK: assert every node points at the mirror, and the cache node runs an authed cache.
  const rows = await Promise.all(nodes.map(async (n) => ({ n, r: await ssh(n.ip, probeCmd(n.name === CACHE_NODE)) })));
  let bad = 0;
  let down = 0;
  for (const { n, r } of rows) {
    const name = n.name.padEnd(11);
    if (r.code !== 0) {
      down++;
      console.error(`  ✗ ${name} UNREACHABLE — ${(r.err || `exit ${r.code}`).split('\n')[0].slice(0, 70)}`);
      continue;
    }
    const v = kv(r.out);
    const mirrorOk = (v.mirrors ?? '').includes(MIRROR_HOSTPORT) || (v.mirrors ?? '').includes(MIRROR_URL);
    const insecureOk = (v.insecure ?? '').includes(MIRROR_HOSTPORT);
    let line = `${mirrorOk ? '✓' : '✗'} ${name} mirror=${mirrorOk ? 'set' : 'MISSING'} insecure=${insecureOk ? 'set' : 'MISSING'}`;
    let nodeBad = !mirrorOk || !insecureOk;
    if (n.name === CACHE_NODE) {
      const cacheOk = v.cache_running === 'true' && Number(v.cache_authed) > 0;
      line += `  | cache running=${v.cache_running || 'no'} authed=${Number(v.cache_authed) > 0 ? 'yes' : 'NO'} upstream=${v.cache_remote || '-'}`;
      nodeBad = nodeBad || !cacheOk;
    }
    if (nodeBad) bad++;
    console.error(`  ${line}`);
  }
  console.error(
    `\n  ${nodes.length - bad - down}/${nodes.length} fully wired, ${bad} mis-configured, ${down} down.` +
      (bad || down ? '  Re-run with --execute to fix.' : '  ✓ cache is fully provisioned.'),
  );
  process.exit(bad + down > 0 ? 1 : 0);
}

// EXECUTE — guard creds for the cache recreate.
if (!NO_CACHE && (!PROXY_USER || !PROXY_PASS)) {
  console.error(
    '  ✗ --execute needs Docker Hub creds for the cache: set REGISTRY_PROXY_USERNAME/REGISTRY_PROXY_PASSWORD\n' +
      '    (or DOCKERHUB_USER/DOCKERHUB_PASS), or pass --no-cache to only wire the mirrors.',
  );
  process.exit(2);
}

// Phase 1 — recreate the authed cache on the cache node FIRST (so the mirrors point at a warm, authed cache).
if (!NO_CACHE && (!only || only.has(CACHE_NODE))) {
  console.error(`  recreating authed cache on ${CACHE_NODE} (preserving its data volume)…`);
  const r = await ssh(cacheNode.ip, cacheCmd());
  const v = kv(r.out);
  const ok = r.code === 0 && Number(v.cache_authed) > 0;
  console.error(
    `  ${ok ? '✓' : '✗'} ${CACHE_NODE.padEnd(11)} ${ok ? `cache authed (volume ${v.reuse_volume})` : (r.err || r.out || `exit ${r.code}`).split('\n').pop().slice(0, 90)}\n`,
  );
}

// Phase 2 — wire the mirror into every node's daemon.json + restart docker (parallel).
let mirrorFail = 0;
const applied = await Promise.all(nodes.map(async (n) => ({ n, r: await ssh(n.ip, mirrorCmd()) })));
for (const { n, r } of applied) {
  const name = n.name.padEnd(11);
  const ok = r.code === 0 && r.out.includes('ok_mirror=');
  if (!ok) mirrorFail++;
  console.error(
    `  ${ok ? '✓' : '✗'} ${name} ${ok ? `mirror wired (${r.out.split('=').pop().trim()})` : (r.err || r.out || `exit ${r.code}`).split('\n').pop().slice(0, 90)}`,
  );
}
if (mirrorFail) {
  console.error(
    `\n  ✗ ${mirrorFail} node(s) NOT wired — likely no passwordless sudo. Provision those manually (need root for daemon.json + docker restart).`,
  );
}
console.error('\n  Re-run without --execute to verify the whole fleet is wired.');
process.exit(mirrorFail > 0 ? 1 : 0);
