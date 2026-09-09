#!/usr/bin/env node
/**
 * `pool-qa` — automated runner for the Hub Pool two-node fleet test.
 *
 * Executes [`docs/hub-pool-fleet-testing.md`](../docs/hub-pool-fleet-testing.md) against two real
 * appliances over plain HTTP and reports PASS / FAIL / SKIP / MANUAL / BLOCKED per step. The plan is
 * a ~90-minute manual runbook; almost all of it is HTTP against `/api/inference/pool/*`, so almost
 * all of it can run itself. What genuinely cannot — stopping an inference engine, editing a node's
 * `.env`, renaming a tailnet device — is reported as MANUAL with the exact command, bracketed by the
 * before/after assertions the runner *can* make.
 *
 * SAFE BY DEFAULT. With no flag this runs read-only checks only: every GET, plus the handful of
 * POSTs that are rejected by a guard or by `proxyToPool`'s guard clause before any engine is
 * touched. Everything that pairs, unpairs, writes a setting, mints a PIN, upgrades a credential or
 * spends GPU time needs `--execute`, and prints what it WOULD do without it. Two steps are hazardous
 * enough to need a second flag on top: `--wrong-pin` (trips a 60s-to-15min per-source cooldown that
 * poisons later PIN steps) and `--rotate-identity` (unpairs EVERY peer on the node, not only the one
 * under test).
 *
 * Every response shape here is hand-mirrored from
 * `packages/backend/src/modules/hub-pool/hub-pool.types.ts` and `hub-pool-routing-log.service.ts`,
 * the way `scripts/hub-pool-cli.ts` mirrors them: the pool routes declare an empty response schema in
 * swagger.json, so there is nothing to import, and this file must stay dependency-free anyway.
 *
 * Usage:
 *   node scripts/pool-qa.mjs --core <addr> --beta <addr>              # read-only preflight + GET probes
 *   node scripts/pool-qa.mjs --core <addr> --beta <addr> --execute    # also the pairing/routing lifecycle
 *   node scripts/pool-qa.mjs --core <addr> --beta <addr> --json       # machine-readable results
 *   node scripts/pool-qa.mjs --core <addr> --beta <addr> --only 1,2,3 # sections, or step ids (--only 2.8)
 *
 *   <addr> is "100.64.0.1", "100.64.0.1:5002", "hub-a.example-tailnet.ts.net", or a full base URL.
 *   With no scheme the runner tries `https://<addr>` first and falls back to
 *   `http://<addr>:$POOL_QA_API_PORT`, and REPORTS the downgrade — that is step 1.2's TLS question,
 *   not a silent workaround. It separately probes `https://<nodeFqdn>` once the name is known,
 *   because every Hub-to-Hub callback is hardcoded to that form with no plain-HTTP fallback
 *   (hub-pool-peer.service.ts:501, :899, :994, :1262; hub-pool-peer.service.ts:1331).
 *
 * Env vars:
 *   POOL_QA_CORE_TOKEN   operator credential for the core node — the `ciHubApiKey` from that node's
 *                        `state/settings.json`, sent as `Authorization: Bearer` (auth.middleware.ts:110-122).
 *                        Per node: core's key does not authenticate on beta.
 *   POOL_QA_BETA_TOKEN   the same, for the beta node.
 *   POOL_QA_TOKEN        fallback used for whichever of the two is unset.
 *   POOL_QA_API_PORT     port for the plain-HTTP fallback base URL   (default: 5002)
 *   POOL_QA_TIMEOUT_MS   budget for operator GET/PATCH calls          (default: 15000)
 *   POOL_QA_INFER_TIMEOUT_MS  budget for a pooled inference request   (default: 120000)
 *   POOL_QA_MODEL_BOTH   a model pulled on BOTH nodes. Discovered by diffing inventories if unset.
 *   POOL_QA_MODEL_BETA   a model pulled on the beta node ONLY. Discovered the same way.
 *
 * Exit code: 0 only when no step FAILed AND teardown put everything back. SKIP / MANUAL / BLOCKED
 * never fail the run — a step the runner could not decide is not a step the product failed — but a
 * fleet left dirty does, because that is the one outcome a caller must never read as success.
 *
 * Teardown: if `--execute` created pairing state, section 10 always runs on the way out, including
 * on Ctrl-C and on an unhandled error, and the report says whether it succeeded.
 */

import process from 'node:process';

// ─────────────────────────────────────────────────────────────────────────────
// Constants mirrored from the backend. Cited, not guessed.
// ─────────────────────────────────────────────────────────────────────────────

/** Global prefix (main.ts:91) + controller prefix (hub-pool.controller.ts:58). */
const POOL = '/api/inference/pool';
/** UNREACHABLE_THRESHOLD (hub-pool-peer.service.ts:70). */
const UNREACHABLE_THRESHOLD = 3;
/** CAPABILITIES_PROBE_TIMEOUT_MS (hub-pool-peer.service.ts:73). */
const PROBE_TIMEOUT_MS = 8_000;
/** CAPABILITIES_FRESHNESS_POLLS (common/helpers/hub-pool.ts:269). */
const FRESHNESS_POLLS = 3;
/** DEFAULT_POOL_HEALTH_POLL_SECONDS (common/helpers/hub-pool.ts:257) — read from /status, never assumed. */
const DEFAULT_POLL_SECONDS = 30;
/** DEFAULT_POOL_LOCAL_AFFINITY (common/helpers/hub-pool.ts:159). */
const DEFAULT_LOCAL_AFFINITY = 1;
/** DEFAULT_POOL_PRESSURE_WEIGHT (common/helpers/hub-pool.ts:251). */
const DEFAULT_PRESSURE_WEIGHT = 0;
/** MIN_PAIR_BY_ADDRESS_PROTOCOL (hub-pool-peer-auth.ts:60). Below this, pairing by address is impossible. */
const MIN_PAIR_BY_ADDRESS_PROTOCOL = 2;
/** TUNNEL_MARKER_HEADERS (common/helpers/hub-pool.ts:359). The runner must never send these. */
const TUNNEL_MARKER_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'true-client-ip'];
/** LOCAL_CANDIDATE_KEY (hub-pool-load.service.ts:4) — the literal `node` value for this Hub. */
const LOCAL_NODE = 'local';
/** PoolAppGuard's refusal (guards/pool-app.guard.ts:36,48). Distinct from InternalNetworkGuard's. */
const POOL_APP_GUARD_MESSAGE = 'The pool proxy is only available to apps on the local appliance network';
/** InternalNetworkGuard's refusal (modules/auth/internal-network.guard.ts:22). Near-identical wording, different guard. */
const INTERNAL_GUARD_MESSAGE = 'This endpoint is only available on the local appliance network';
/** proxyToPool's guard clause (hub-pool.controller.ts:492). */
const NO_MODEL_MESSAGE = 'Request body must include a "model" field';
/** PIN_FAILURE_MESSAGE (hub-pool-pairing-pin.service.ts:18) — uniform for wrong / expired / already-used / none. */
const PIN_FAILURE_MESSAGE = 'Invalid or expired pairing PIN';

const API_PORT = Number(process.env.POOL_QA_API_PORT) || 5002;
const TIMEOUT_MS = Number(process.env.POOL_QA_TIMEOUT_MS) || 15_000;
const INFER_TIMEOUT_MS = Number(process.env.POOL_QA_INFER_TIMEOUT_MS) || 120_000;
/** Base-URL discovery must not spend the full budget on a port nothing listens on. */
const RESOLVE_TIMEOUT_MS = Math.min(TIMEOUT_MS, 6_000);
/** `peers/discoverable` fans out one HTTPS probe per tailnet device — the CLI's mutation budget, not its GET one (hub-pool-cli.ts:17-20). */
const DISCOVERY_TIMEOUT_MS = 30_000;
/** How long an aborted stream body is given to unwind before the runner stops waiting on it. */
const STREAM_UNWIND_MS = 10_000;

const VERDICTS = ['PASS', 'FAIL', 'SKIP', 'MANUAL', 'BLOCKED'];

// ─────────────────────────────────────────────────────────────────────────────
// Verdict constructors. `blocked` is also where "inconclusive" lands: a step whose
// precondition makes the assertion undecidable has not failed, and must not fail the run.
// ─────────────────────────────────────────────────────────────────────────────

const pass = (reason, data) => ({ verdict: 'PASS', reason, data });
const fail = (reason, data) => ({ verdict: 'FAIL', reason, data });
const skip = (reason, data) => ({ verdict: 'SKIP', reason, data });
const manual = (reason, data) => ({ verdict: 'MANUAL', reason, data });
const blocked = (reason, data) => ({ verdict: 'BLOCKED', reason, data });

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `pool-qa — automated runner for the Hub Pool two-node fleet test (docs/hub-pool-fleet-testing.md)

Usage:
  node scripts/pool-qa.mjs --core <addr> --beta <addr> [options]

Required:
  --core <addr>          the node the plan calls <core-node>: ip, ip:port, MagicDNS name, or base URL
  --beta <addr>          the node the plan calls <beta-node>

Options:
  --execute              run mutating steps too (pairing, settings, PINs, pooled inference).
                         Without it every mutating step prints what it WOULD do and is SKIPped.
  --wrong-pin            allow step 2.9d. Trips a 60s-to-15min per-source cooldown on that node.
  --rotate-identity      allow step 2.11. Unpairs EVERY peer on the core node, not only beta.
  --only <list>          sections or step ids, comma separated: --only 1,2 or --only 2.8,9
  --interactive          pause at each MANUAL step and wait for the operator to confirm
  --no-teardown          leave pairing state behind (default is to always tear down what we created)
  --json                 emit machine-readable results on stdout and nothing else
  --core-token <t>       operator credential for core (or POOL_QA_CORE_TOKEN)
  --beta-token <t>       operator credential for beta (or POOL_QA_BETA_TOKEN)
  --help                 this text

Env: POOL_QA_API_PORT (${API_PORT}), POOL_QA_TIMEOUT_MS (${TIMEOUT_MS}), POOL_QA_INFER_TIMEOUT_MS (${INFER_TIMEOUT_MS}),
     POOL_QA_MODEL_BOTH, POOL_QA_MODEL_BETA, POOL_QA_CORE_TOKEN, POOL_QA_BETA_TOKEN, POOL_QA_TOKEN

Exit code: 0 when no step FAILed and teardown was clean. 1 on a FAIL, a runner error, or a teardown
that could not put the fleet back. 2 on a bad invocation (including an --only that matches no step).
SKIP / MANUAL / BLOCKED do not fail the run.`;

/** Parse argv into options. Unknown flags are an error — a typo'd `--execute` must not run silently read-only. */
function parseArgs(argv) {
  const opts = {
    core: null,
    beta: null,
    execute: false,
    wrongPin: false,
    rotateIdentity: false,
    only: null,
    interactive: false,
    teardown: true,
    json: false,
    help: false,
    coreToken: process.env.POOL_QA_CORE_TOKEN || process.env.POOL_QA_TOKEN || null,
    betaToken: process.env.POOL_QA_BETA_TOKEN || process.env.POOL_QA_TOKEN || null,
  };
  const takesValue = new Set(['--core', '--beta', '--only', '--core-token', '--beta-token']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      if (arg === '--core') opts.core = value;
      if (arg === '--beta') opts.beta = value;
      if (arg === '--only')
        opts.only = value
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean);
      if (arg === '--core-token') opts.coreToken = value;
      if (arg === '--beta-token') opts.betaToken = value;
      continue;
    }
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--wrong-pin') opts.wrongPin = true;
    else if (arg === '--rotate-identity') opts.rotateIdentity = true;
    else if (arg === '--interactive') opts.interactive = true;
    else if (arg === '--no-teardown') opts.teardown = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Address parsing and base-URL discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split what the operator typed into a scheme (if any), a host, and a port (if any).
 *
 * Accepts a full base URL, `host:port`, a bare host or IPv4, and a bracketed IPv6 literal. The port
 * is kept separate because the plain-HTTP fallback has to supply one and the HTTPS form must not.
 */
function parseAddress(raw) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return {
      explicit: true,
      base: `${url.protocol}//${url.host}`,
      host: url.hostname,
      port: url.port ? Number(url.port) : null,
      https: url.protocol === 'https:',
    };
  }
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { explicit: false, host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : null, ipv6: true };
  }
  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { explicit: false, host: parts[0], port: Number(parts[1]), ipv6: false };
  }
  if (parts.length > 2) {
    // A bare IPv6 literal with no brackets. Legal input, no port.
    return { explicit: false, host: trimmed, port: null, ipv6: true };
  }
  return { explicit: false, host: trimmed, port: null, ipv6: false };
}

/** `host` or `[host]`, for building an authority. */
const hostLiteral = (parsed) => (parsed.ipv6 ? `[${parsed.host}]` : parsed.host);

/**
 * Ask one candidate base URL what is there.
 *
 * `GET identify` is the only unauthenticated non-write in the module (hub-pool.controller.ts:99-102)
 * and answers three different questions by status alone: 200 = Hub Pool is here, 404 = something is
 * answering but has no pool routes, anything else = not a Hub. The 404 case is confirmed against an
 * AuthGuard-protected route that predates Hub Pool, so "old build" is never confused with "wrong port".
 */
async function probeBase(base) {
  const identify = await rawFetch(`${base}${POOL}/identify`, { timeoutMs: RESOLVE_TIMEOUT_MS });
  if (identify.error) {
    return { base, reachable: false, error: identify.error };
  }
  if (identify.status === 200 && identify.json && identify.json.isCiHub === true) {
    const protocol = typeof identify.json.poolProtocol === 'number' ? identify.json.poolProtocol : 1;
    return { base, reachable: true, hasPool: true, protocol, identify: identify.json, legacy: !('poolProtocol' in identify.json) };
  }
  if (identify.status === 404) {
    // hub-pool.controller.ts is absent from this build. Confirm a CI-Hub API is still there:
    // `system-inspector/health` is AuthGuard-only, so an unauthenticated 401 is proof of a Hub.
    const health = await rawFetch(`${base}/api/system-inspector/health`, { timeoutMs: RESOLVE_TIMEOUT_MS });
    const isHub = health.status === 401 || health.status === 200;
    return { base, reachable: true, hasPool: false, isHub, status: 404 };
  }
  return { base, reachable: true, hasPool: false, isHub: false, status: identify.status };
}

/**
 * Resolve one operator-typed address to a working base URL, and classify the build behind it.
 *
 * HTTPS first, then plain HTTP on the API port — the doc's form first, then the one the verified
 * fleet actually answers on. The downgrade is recorded rather than swallowed: it is the same
 * question step 1.2 asks, and it decides whether sections 2 and 5-7 can run at all, because every
 * Hub-to-Hub callback is `https://<nodeFqdn>` with no fallback.
 */
async function resolveNode(label, raw, token) {
  const parsed = parseAddress(raw);
  const node = {
    label,
    input: raw,
    host: parsed.host,
    token,
    base: null,
    baseForm: null,
    downgraded: false,
    hasPool: false,
    protocol: null,
    legacyIdentify: false,
    isHub: false,
    fqdn: null,
    httpsFqdn: null,
    attempts: [],
  };

  const candidates = [];
  if (parsed.explicit) {
    candidates.push({ base: parsed.base, form: parsed.https ? 'https (as given)' : 'http (as given)' });
  } else if (parsed.port === null) {
    candidates.push({ base: `https://${hostLiteral(parsed)}`, form: 'https://<addr>' });
    candidates.push({ base: `http://${hostLiteral(parsed)}:${API_PORT}`, form: `http://<addr>:${API_PORT}` });
  } else {
    candidates.push({ base: `https://${hostLiteral(parsed)}:${parsed.port}`, form: 'https://<addr>:<port>' });
    candidates.push({ base: `http://${hostLiteral(parsed)}:${parsed.port}`, form: 'http://<addr>:<port>' });
  }

  for (const candidate of candidates) {
    const result = await probeBase(candidate.base);
    node.attempts.push({ ...candidate, ...result });
    if (result.reachable && result.hasPool) {
      node.base = candidate.base;
      node.baseForm = candidate.form;
      node.hasPool = true;
      node.isHub = true;
      node.protocol = result.protocol;
      node.legacyIdentify = result.legacy;
      break;
    }
  }
  if (!node.base) {
    // No candidate spoke Hub Pool. Fall back to one that answered at all, so the report can say
    // "old build" rather than "unreachable" — those need different fixes.
    const answered = node.attempts.find((attempt) => attempt.reachable && attempt.isHub) ?? node.attempts.find((attempt) => attempt.reachable);
    if (answered) {
      node.base = answered.base;
      node.baseForm = answered.form;
      node.isHub = Boolean(answered.isHub);
    }
  }
  node.downgraded = node.baseForm?.startsWith('http://') === true && candidates.length > 1;
  // The address the far Hub will be asked to dial in step 1.2b. `peers/probe` walks its own port
  // ladder (hub-pool-probe.ts:103-110), so a port is only sent when the operator pinned one.
  node.probeAddress = parsed.port === null ? parsed.host : `${hostLiteral(parsed)}:${parsed.port}`;
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancels every in-flight STEP request when the operator interrupts the run.
 *
 * Held at module scope and read at call time, never captured: `bail` clears it before awaiting
 * teardown, so teardown's own calls — the ones that put the fleet back — are issued without it and
 * are never cancelled by the same Ctrl-C that stopped the step.
 */
let runAbort = null;

/**
 * One request, with the two rules every app-facing call on this runner must obey:
 * no tunnel-marker header and no `X-Forwarded-For` (guards/pool-app.guard.ts:34-50). Nothing here
 * ever sets them except the steps in 9.1 that are deliberately testing the refusal.
 */
async function rawFetch(url, options = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = TIMEOUT_MS } = options;
  const requestHeaders = { accept: 'application/json', ...headers };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  // A step's request must die with the run; teardown's must not (see `runAbort`).
  const cancel = runAbort ? AbortSignal.any([controller.signal, runAbort.signal]) : controller.signal;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: cancel,
      redirect: 'manual',
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, headers: response.headers, text, json, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message =
      error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error);
    return { ok: false, status: 0, error: message, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A call against one node. `auth: 'operator'` attaches that node's own `ciHubApiKey` as a bearer
 * (auth.middleware.ts:117-122); `auth: 'none'` attaches nothing, which is what the app-facing and
 * peer-facing routes need. A missing credential is reported as a missing credential, never as a
 * product failure.
 */
async function call(node, path, options = {}) {
  const { auth = 'operator', headers = {}, ...rest } = options;
  if (!node.base) {
    return { ok: false, status: 0, error: `${node.label}: no reachable base URL`, unreachableNode: true };
  }
  const requestHeaders = { ...headers };
  if (auth === 'operator') {
    if (!node.token) {
      return { ok: false, status: 0, error: `${node.label}: no operator credential`, noToken: true };
    }
    requestHeaders.authorization = `Bearer ${node.token}`;
  }
  return rawFetch(`${node.base}${path}`, { ...rest, headers: requestHeaders });
}

/** The message a Nest exception filter put in the body, when there is one. */
function errorText(res) {
  if (!res) return 'no response';
  if (res.error) return res.error;
  const body = res.json;
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.join('; ');
    if (typeof body.error === 'string') return body.error;
  }
  return res.text ? res.text.slice(0, 160) : `HTTP ${res.status}`;
}

/** `HTTP 409 Already paired…` — the one-line form every FAIL reason uses. */
const httpSummary = (res) => (res.error ? `transport error: ${res.error}` : `HTTP ${res.status} ${errorText(res)}`.trim());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A cancellable deadline, for racing against work that carries no timeout of its own.
 *
 * The timer is unref'd and cleared once the race settles: a pending `setTimeout` would otherwise
 * hold the event loop open for the rest of its budget after the answer is known, which on the 120s
 * inference budget looks exactly like a hang.
 */
function deadline(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return { promise, cancel: () => (timer === null ? undefined : clearTimeout(timer)) };
}

/** Await `work` with a budget. `true` = it finished in time, `false` = the budget ran out first. */
async function within(work, budgetMs) {
  const limit = deadline(budgetMs);
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      limit.promise,
    ]);
  } finally {
    limit.cancel();
  }
}

/** Poll `probe` until it returns a truthy value or the deadline passes. Returns `null` on timeout. */
async function until(probe, { budgetMs, intervalMs = 1000 }) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool-shaped readers
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /status` (hub-pool.controller.ts:111-115). The one call that answers most of the plan. */
const getStatus = (node) => call(node, `${POOL}/status`);
/** `GET /peers` (hub-pool.controller.ts:173-177). Raw rows — no `authMode`, no `peerKeyFingerprint`. */
const getPeers = (node) => call(node, `${POOL}/peers`);
/** `GET /settings` (hub-pool.controller.ts:117-121). */
const getSettings = (node) => call(node, `${POOL}/settings`);
/** `GET /routing-log` (hub-pool.controller.ts:135-139). Newest first; limit is 1..200. */
const getRoutingLog = (node, limit = 5) => call(node, `${POOL}/routing-log?limit=${limit}`);

/** Health-poll cadence for this node, read rather than assumed (dto bounds 10..300). */
function pollSeconds(status) {
  const value = status?.settings?.poolHealthPollSeconds;
  return Number.isInteger(value) ? value : DEFAULT_POLL_SECONDS;
}

/** Find the row for a given FQDN in a `/status` or `/peers` payload. */
const findPeerRow = (rows, fqdn) => (Array.isArray(rows) && fqdn ? (rows.find((row) => row.nodeFqdn === fqdn) ?? null) : null);

/** Does any healthy backend on this node hold the model? The exact predicate the ranker applies. */
const backendsHold = (backends, model) =>
  Array.isArray(backends) &&
  backends.some((backend) => backend.healthy === true && Array.isArray(backend.modelsLoaded) && backend.modelsLoaded.includes(model));

/** Every model name a node's healthy backends report, deduplicated. */
function modelsOf(backends) {
  const names = new Set();
  for (const backend of Array.isArray(backends) ? backends : []) {
    if (backend.healthy !== true) continue;
    for (const model of backend.modelsLoaded ?? []) names.add(model);
  }
  return names;
}

/**
 * Is the peer's cached capability snapshot still trusted?
 *
 * A stale one is scored at UNKNOWN_PEER_LOAD = 1 rather than its real depth
 * (hub-pool-proxy.service.ts:44, :655-666), which turns 4.1's decisive "peer 1 vs local 2" into a
 * 2-vs-2 tie local wins — a false FAIL on the plan's headline step. Hence a hard gate, not a note.
 */
function snapshotFresh(peer, seconds) {
  if (!peer?.lastSeenAt) return false;
  const age = Date.now() - Date.parse(peer.lastSeenAt);
  return Number.isFinite(age) && age <= seconds * 1000 * FRESHNESS_POLLS;
}

/** Entries newer than a watermark, newest first, optionally filtered. */
function entriesSince(log, sinceMs, filter = () => true) {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  return entries.filter((entry) => Date.parse(entry.at) >= sinceMs - 1000 && filter(entry));
}

/**
 * Rows the routing log gained between two `GET /routing-log` snapshots, on the HUB's own clock.
 *
 * `summary.recorded` cannot answer this. It is `this.entries.length`
 * (hub-pool-routing-log.service.ts:104) over a ring that `record()` splices back down to
 * `ROUTING_LOG_CAPACITY = 200` on every insert (same file, :6, :88-91), so on any appliance that has
 * already served 200 pooled requests it is pinned at 200 and a diff of it is always 0 — an assertion
 * built on it can never fail. `summary.lastAt` (:110) is the newest entry's own timestamp, so it is
 * a watermark in the node's clock and immune to skew between the runner and the node.
 *
 * Entries recorded in the same millisecond as the watermark are not counted; the alternative is
 * counting the watermark row itself on every call.
 */
function rowsAfter(before, after, filter = () => true) {
  const watermark = Date.parse(before?.summary?.lastAt ?? '');
  const entries = Array.isArray(after?.entries) ? after.entries : [];
  return entries.filter((entry) => {
    if (!filter(entry)) return false;
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) return false;
    return Number.isFinite(watermark) ? at > watermark : true;
  });
}

/** A one-line rendering of a routing decision, in the CLI's own vocabulary (hub-pool-cli.ts:647-673). */
const describeEntry = (entry) =>
  entry
    ? `${entry.direction} ${entry.path} model=${entry.model ?? '-'} node=${entry.node ?? '-'} att ${entry.attempt}/${entry.candidates} ${entry.outcome} ${entry.status ?? '-'}`
    : 'no entry';

// ─────────────────────────────────────────────────────────────────────────────
// Gates every step reuses
// ─────────────────────────────────────────────────────────────────────────────

/** A node with no `/identify` route predates Hub Pool; say so once, clearly, instead of failing every later step. */
function poolGate(...nodes) {
  for (const node of nodes) {
    if (!node.base)
      return `${node.label} is unreachable at ${node.input} (${node.attempts.map((a) => `${a.form}: ${a.error ?? `HTTP ${a.status}`}`).join('; ')})`;
    if (!node.hasPool) {
      return node.isHub
        ? `${node.label} is running a build without Hub Pool — no ${POOL}/* routes (404 on /identify)`
        : `${node.label} answered on ${node.base} but is not a CI-Hub API`;
    }
  }
  return null;
}

/** Operator routes need that node's own key; a 401 here is a missing credential, not a plan failure. */
function tokenGate(...nodes) {
  const missing = nodes.filter((node) => !node.token).map((node) => node.label);
  if (missing.length === 0) return null;
  const vars = missing.map((label) => `POOL_QA_${label.toUpperCase()}_TOKEN`).join(' / ');
  return `no operator credential for ${missing.join(' and ')} (set ${vars})`;
}

/** Pairing by address, and therefore PIN pairing, needs protocol >= 2 on both sides. */
function protocolGate(...nodes) {
  const old = nodes
    .filter((node) => (node.protocol ?? 1) < MIN_PAIR_BY_ADDRESS_PROTOCOL)
    .map((node) => `${node.label} (protocol ${node.protocol ?? 1})`);
  return old.length ? `pairing by address needs pool protocol >= ${MIN_PAIR_BY_ADDRESS_PROTOCOL}: ${old.join(', ')}` : null;
}

/** Run the first gate that bites, in the order that produces the most useful message. */
function gate(...checks) {
  for (const check of checks) {
    if (check) return blocked(check);
  }
  return null;
}

/** The two models the plan needs, or an explanation of why they could not be established. */
function modelGate(state) {
  if (!state.models.both || !state.models.beta) {
    return state.models.error ?? 'model placeholders <model-both>/<model-beta> are not established';
  }
  return null;
}

/**
 * A model id for the guard checks in section 9 and the local-only POST in 8.12.
 *
 * Those steps are refused (or served locally) before anything reads `model`, so they must not be
 * blocked merely because the two plan placeholders could not be discovered — that would hide a real
 * security regression behind an inventory problem.
 */
const probeModel = (state) => state.models.both ?? state.models.beta ?? state.anyLocalModel ?? 'pool-qa-guard-probe';

// ─────────────────────────────────────────────────────────────────────────────
// Streaming, for the load-handoff steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a pooled streaming completion and hold it.
 *
 * The in-flight counter is acquired before the forward and released in a `finally` AFTER the stream
 * is piped (hub-pool-proxy.service.ts:186-238), so the depth is held for the whole generation. That
 * is what makes 3.3 and 4.1 schedulable at all. Aborting the client is a clean release.
 */
async function openHeldStream(ctx, node, model, prompt, label) {
  const controller = new AbortController();
  const url = `${node.base}${POOL}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true });
  const headerTimer = setTimeout(() => controller.abort(new Error('header wait timed out')), INFER_TIMEOUT_MS);
  const held = {
    label,
    controller,
    status: 0,
    chunks: 0,
    bytes: 0,
    capture: [],
    capturing: false,
    finished: false,
    error: null,
    openedAt: Date.now(),
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
      signal: controller.signal,
    });
    clearTimeout(headerTimer);
    held.status = response.status;
    if (!response.ok || !response.body) {
      held.finished = true;
      held.error = `HTTP ${response.status}`;
      held.text = await response.text().catch(() => '');
      return held;
    }
    held.pump = (async () => {
      for await (const chunk of response.body) {
        held.chunks += 1;
        held.bytes += chunk.length;
        if (held.capturing) held.capture.push(Buffer.from(chunk));
      }
    })()
      .then(() => {
        held.finished = true;
      })
      .catch((error) => {
        held.finished = true;
        held.error = error instanceof Error ? error.message : String(error);
      });
    ctx.state.heldStreams.push(held);
    return held;
  } catch (error) {
    clearTimeout(headerTimer);
    held.finished = true;
    held.error = error instanceof Error ? error.message : String(error);
    return held;
  }
}

/**
 * Abort every held stream and wait for its pump to unwind. Always safe to call twice.
 *
 * Bounded, because teardown calls this: a socket that dies without a FIN leaves the body iterator
 * pending forever, and a teardown that never returns is worse than one that reports a stuck stream.
 */
async function releaseHeldStreams(ctx) {
  const held = ctx.state.heldStreams.splice(0);
  for (const stream of held) {
    try {
      stream.controller.abort(new Error('released by runner'));
    } catch {
      stream.error = stream.error ?? 'abort failed';
    }
  }
  await within(Promise.allSettled(held.map((stream) => stream.pump).filter(Boolean)), STREAM_UNWIND_MS);
  return held.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pooled inference, non-streaming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pooled request on an app-facing route. No `Authorization` — these carry
 * `InternalNetworkGuard + PoolAppGuard` only (hub-pool.controller.ts:415-419) — and never a tunnel
 * marker or an `X-Forwarded-For`, or PoolAppGuard 403s and the step would be testing the runner.
 */
const poolInfer = (node, path, body, timeoutMs = INFER_TIMEOUT_MS) => call(node, `${POOL}${path}`, { method: 'POST', body, auth: 'none', timeoutMs });

/** The `chat.completions` body the plan uses for a one-word answer. */
const shortChat = (model) => ({ model, messages: [{ role: 'user', content: 'reply with the word ok' }], stream: false });

/** Did this look like an OpenAI completion? `choices[]` is the shape the plan's PASS depends on. */
const looksOpenAi = (json) => Boolean(json && typeof json === 'object' && Array.isArray(json.choices));

/**
 * Classify a 502 from the proxy. The two texts mean different things and the plan's PASS/FAIL flips
 * on which one arrived: `describeNoCandidates` (hub-pool-proxy.service.ts:117-127) means selection
 * produced nothing, the all-failed text (:359) means candidates existed and every one was tried.
 */
function classify502(res, model) {
  const text = typeof res.json?.error === 'string' ? res.json.error : '';
  if (text.startsWith(`No pool node currently has model "${model}" available.`)) return 'no-candidates';
  if (text.startsWith(`All pool nodes serving model "${model}"`)) return 'all-unreachable';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 1: preflight
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_1 = [
  {
    id: '1.1',
    title: 'Both nodes are on the tailnet',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      for (const [node, res] of [
        [ctx.core, core],
        [ctx.beta, beta],
      ]) {
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
      }
      ctx.state.status.core = core.json;
      ctx.state.status.beta = beta.json;
      ctx.core.fqdn = core.json.localNode?.nodeFqdn ?? null;
      ctx.beta.fqdn = beta.json.localNode?.nodeFqdn ?? null;
      const problems = [];
      for (const [node, res] of [
        [ctx.core, core],
        [ctx.beta, beta],
      ]) {
        if (res.json.localNode?.tailscaleConnected !== true) problems.push(`${node.label} reports Tailscale not connected`);
        if (!node.fqdn) problems.push(`${node.label} has no nodeFqdn`);
      }
      if (ctx.core.fqdn && ctx.core.fqdn === ctx.beta.fqdn) problems.push(`both --core and --beta resolve to the same Hub (${ctx.core.fqdn})`);
      if (problems.length) return fail(problems.join('; '));
      const tailnets = [core.json.localNode.tailnet, beta.json.localNode.tailnet];
      return pass(`core=${ctx.core.fqdn} beta=${ctx.beta.fqdn} (tailnet ${tailnets[0] ?? '-'}/${tailnets[1] ?? '-'})`, { tailnets });
    },
  },
  {
    id: '1.2a',
    title: 'Each Hub answers /identify, and builds without Hub Pool are named as such',
    on: 'both',
    wire: `GET ${POOL}/identify`,
    tier: 'readonly',
    async run(ctx) {
      const lines = [];
      let failed = false;
      for (const node of [ctx.core, ctx.beta]) {
        if (!node.base) {
          lines.push(`${node.label}: unreachable at ${node.input}`);
          failed = true;
        } else if (node.hasPool) {
          const shape = node.legacyIdentify ? 'no poolProtocol => protocol 1 (older build)' : `poolProtocol ${node.protocol}`;
          lines.push(`${node.label}: isCiHub via ${node.baseForm}, ${shape}${node.downgraded ? ' [DOWNGRADED to plain HTTP]' : ''}`);
        } else {
          // 404 on /identify is not a plan failure — it is a build that predates the module.
          lines.push(`${node.label}: ${node.isHub ? 'CI-Hub without Hub Pool (404 on /identify)' : 'not a CI-Hub API'} via ${node.baseForm}`);
        }
      }
      // The runner's own reachability is not the pool's. Every Hub-to-Hub call is https://<fqdn>,
      // so this is the probe that decides whether sections 2 and 5-7 can complete at all.
      for (const node of [ctx.core, ctx.beta]) {
        if (!node.fqdn) {
          lines.push(
            `${node.label}: https://<fqdn> NOT PROBED — the node’s own MagicDNS name is only on GET /status, which needs an operator credential`,
          );
          continue;
        }
        const res = await rawFetch(`https://${node.fqdn}${POOL}/identify`, { timeoutMs: RESOLVE_TIMEOUT_MS });
        node.httpsFqdn = res.status === 200 || res.status === 404;
        lines.push(
          `${node.label}: https://<fqdn> ${node.httpsFqdn ? 'answers' : `does NOT answer (${res.error ?? `HTTP ${res.status}`}) — Hub-to-Hub callbacks cannot complete`}`,
        );
      }
      if (failed) return fail(lines.join(' | '));
      const anyPool = ctx.core.hasPool || ctx.beta.hasPool;
      return anyPool ? pass(lines.join(' | ')) : blocked(lines.join(' | '));
    },
  },
  {
    id: '1.2b',
    title: 'Each node can actually reach the other Hub (node-to-node, not runner-to-node)',
    on: 'both',
    wire: `POST ${POOL}/peers/probe  (POST, no state change)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const results = [];
      for (const [from, to] of [
        [ctx.core, ctx.beta],
        [ctx.beta, ctx.core],
      ]) {
        const res = await call(from, `${POOL}/peers/probe`, { method: 'POST', body: { address: to.probeAddress } });
        if (!res.ok) {
          results.push({ from: from.label, to: to.label, ok: false, detail: httpSummary(res) });
          continue;
        }
        const probe = res.json ?? {};
        results.push({
          from: from.label,
          to: to.label,
          ok: probe.isCiHub === true && probe.pairable === true && probe.reason === null,
          detail: `isCiHub=${probe.isCiHub} pairable=${probe.pairable} protocol=${probe.poolProtocol ?? '-'} reason=${probe.reason ?? 'null'}`,
        });
      }
      ctx.state.probe = results;
      const summary = results.map((row) => `${row.from}->${row.to}: ${row.detail}`).join(' | ');
      return results.every((row) => row.ok) ? pass(summary) : fail(summary);
    },
  },
  {
    id: '1.3',
    title: 'Discovery credentials on at least one node',
    on: 'both',
    wire: `GET ${POOL}/status (tailscaleAdminApiConfigured)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const core = ctx.state.status.core ?? (await getStatus(ctx.core)).json;
      const beta = ctx.state.status.beta ?? (await getStatus(ctx.beta)).json;
      const flags = { core: core?.tailscaleAdminApiConfigured === true, beta: beta?.tailscaleAdminApiConfigured === true };
      if (flags.core || flags.beta)
        return pass(`Admin API configured on ${[flags.core && 'core', flags.beta && 'beta'].filter(Boolean).join(' and ')}`);
      // Not fatal: pairing by address + PIN needs no Admin API at all.
      return blocked('Admin API configured on neither node — discovery (2.1) returns [] and pairing must go by nodeFqdn or address+PIN');
    },
  },
  {
    id: '1.4a',
    title: 'Model inventory differs between the nodes',
    on: 'both',
    wire: `GET ${POOL}/status (localNode.backends)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      if (!core.ok || !beta.ok) return fail(`core ${httpSummary(core)} / beta ${httpSummary(beta)}`);
      ctx.state.status.core = core.json;
      ctx.state.status.beta = beta.json;
      const errors = [];
      for (const [node, res] of [
        [ctx.core, core],
        [ctx.beta, beta],
      ]) {
        const capabilitiesError = res.json.localNode?.capabilitiesError;
        if (capabilitiesError) errors.push(`${node.label} capabilitiesError: ${capabilitiesError}`);
        else if (!(res.json.localNode?.backends ?? []).some((backend) => backend.healthy === true))
          errors.push(`${node.label} has no healthy backend`);
      }
      if (errors.length) return fail(errors.join('; '));
      await establishModels(ctx, modelsOf(core.json.localNode.backends), modelsOf(beta.json.localNode.backends), '/status');
      const gapped = modelGate(ctx.state);
      if (gapped) return blocked(gapped);
      if (modelsOf(core.json.localNode.backends).has(ctx.state.models.beta)) {
        return fail(
          `<model-beta> "${ctx.state.models.beta}" is present on core too — sections 3 and 4 cannot tell a correct routing decision from a lucky one`,
        );
      }
      return pass(`<model-both>="${ctx.state.models.both}" <model-beta>="${ctx.state.models.beta}" (${ctx.state.models.source})`);
    },
  },
  {
    id: '1.4b',
    title: 'App-facing proxy surface is reachable and lists that node’s own models',
    on: 'both',
    wire: `GET ${POOL}/api/tags`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const lines = [];
      let failed = false;
      for (const node of [ctx.core, ctx.beta]) {
        const res = await call(node, `${POOL}/api/tags`, { auth: 'none' });
        if (res.status === 200 && Array.isArray(res.json?.models)) {
          lines.push(`${node.label}: ${res.json.models.length} model(s)`);
          continue;
        }
        if (res.status === 403) {
          // A guard refusal is a runner-configuration fact, not a product failure.
          lines.push(`${node.label}: 403 ${errorText(res)} — runner source is not private/CGNAT, or a proxy header leaked`);
          continue;
        }
        failed = true;
        lines.push(`${node.label}: ${httpSummary(res)}`);
      }
      return failed ? fail(lines.join(' | ')) : pass(lines.join(' | '));
    },
  },
];

/**
 * Establish `<model-both>` and `<model-beta>`.
 *
 * Env wins; otherwise diff the two inventories, because that is what the placeholders mean. Model
 * ids are compared verbatim and case-sensitively against `modelsLoaded` on the request path
 * (hub-pool.dto.ts:186-192), so nothing here normalizes anything.
 */
async function establishModels(ctx, coreModels, betaModels, source) {
  const envBoth = process.env.POOL_QA_MODEL_BOTH?.trim();
  const envBeta = process.env.POOL_QA_MODEL_BETA?.trim();
  if (envBoth && envBeta) {
    ctx.state.models = { both: envBoth, beta: envBeta, source: 'env' };
    return;
  }
  const shared = [...coreModels].filter((model) => betaModels.has(model)).sort();
  const betaOnly = [...betaModels].filter((model) => !coreModels.has(model)).sort();
  const both = envBoth ?? shared[0] ?? null;
  const beta = envBeta ?? betaOnly[0] ?? null;
  // `/api/show` and friends are served by the CORE node's own engine, so they need a model that
  // node really has — a peer-only id gets a 502 from proxyLocalOnlyRequest, which is not a defect.
  ctx.state.coreLocalModel = [...coreModels].sort()[0] ?? null;
  ctx.state.anyLocalModel = ctx.state.coreLocalModel ?? [...betaModels].sort()[0] ?? null;
  const missing = [];
  if (!both) missing.push('<model-both>: no model appears on both nodes');
  if (!beta) missing.push('<model-beta>: no model is unique to beta');
  ctx.state.models = {
    both,
    beta,
    source: envBoth || envBeta ? 'env + discovered' : `discovered from ${source}`,
    coreInventory: [...coreModels].sort(),
    betaInventory: [...betaModels].sort(),
    error: missing.length
      ? `${missing.join('; ')} — core has [${[...coreModels].sort().join(', ') || 'nothing'}], beta has [${[...betaModels].sort().join(', ') || 'nothing'}]. Set POOL_QA_MODEL_BOTH / POOL_QA_MODEL_BETA, or pull a shared model.`
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 2: pairing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which pairing form can actually work on this pair.
 *
 * Pairing BY NAME dials `https://<nodeFqdn>/api/inference/pool/pair/request` with no port and no
 * plain-HTTP fallback (hub-pool-peer.service.ts:501). On a cert-less fleet that cannot work, and
 * pairing BY ADDRESS is the only viable path, because `pairAtAddress` re-probes with the http-first
 * port ladder and dials whichever authority answered (hub-pool-discovery.service.ts:82-95).
 */
function pairingForm(ctx) {
  const protocolProblem = protocolGate(ctx.core, ctx.beta);
  if (!protocolProblem) return { mode: 'address', why: 'address + PIN (works without Tailscale HTTPS certs)' };
  if (ctx.beta.httpsFqdn === true) return { mode: 'fqdn', why: `nodeFqdn (protocol too old for address pairing: ${protocolProblem})` };
  return { mode: null, why: `${protocolProblem}, and https://<beta fqdn> does not answer, so neither pairing form can complete` };
}

/** Mint a PIN on a node. The digits are returned exactly once and are never logged or stored on disk. */
async function mintPin(ctx, node) {
  const res = await call(node, `${POOL}/pairing-pin`, { method: 'POST', body: {} });
  if (!res.ok || typeof res.json?.pin !== 'string') return { ok: false, res };
  ctx.state.pinMintedOn.add(node.label);
  return {
    ok: true,
    pin: res.json.pin,
    mintedAt: Date.now(),
    expiresAt: res.json.expiresAt,
    fingerprint: res.json.publicKeyFingerprint ?? null,
    identityError: res.json.identityError ?? null,
  };
}

/** Start pairing from core, in whichever form this pair supports. Records the row id on success. */
async function initiatePairing(ctx, { displayName = 'pool-qa beta' } = {}) {
  const form = pairingForm(ctx);
  if (!form.mode) return { ok: false, reason: form.why };
  let body;
  if (form.mode === 'address') {
    const minted = await mintPin(ctx, ctx.beta);
    if (!minted.ok) return { ok: false, reason: `could not mint a PIN on beta: ${httpSummary(minted.res)}` };
    ctx.state.betaFingerprint = minted.fingerprint;
    ctx.state.lastPin = minted.pin;
    body = { address: ctx.beta.probeAddress, pin: minted.pin, displayName };
  } else {
    body = { nodeFqdn: ctx.beta.fqdn, displayName };
  }
  const res = await call(ctx.core, `${POOL}/peers/pair`, { method: 'POST', body, timeoutMs: 30_000 });
  if (!res.ok) {
    // `initiatePairing` throws a plain Error when the peer refuses, and MainExceptionFilter only
    // forwards `exception.message` when the status is not 500 (common/error/exception.filter.ts:51,
    // 74-76, 93-96) — so the actionable text never reaches the caller. Say that, rather than nothing.
    const detail = res.status === 500 ? 'HTTP 500 INTERNAL_SERVER_ERROR — peer declined; the reason exists only in core’s logs' : httpSummary(res);
    return { ok: false, reason: `${form.mode} form: ${detail}`, res, form };
  }
  ctx.state.paired = true;
  ctx.state.peerIdOnCore = res.json?.id ?? null;
  // Remembered so teardown can tell a row THIS run created from one that was already there.
  if (res.json?.id) ctx.state.createdPeerIds.add(res.json.id);
  return { ok: true, row: res.json, form };
}

/**
 * Resolve the inbound row beta holds FOR CORE. The HTTP API is addressed by full uuid, never a prefix.
 *
 * Never falls back to "the first row": approving or rejecting an arbitrary row would act on some
 * third node's pairing request, which is someone else's decision and not reversible from here.
 */
async function inboundRowOnBeta(ctx) {
  const res = await getPeers(ctx.beta);
  if (!res.ok) return { ok: false, res };
  const rows = res.json ?? [];
  if (!ctx.core.fqdn) return { ok: false, rows, unattributable: true };
  const row = rows.find((candidate) => candidate.nodeFqdn === ctx.core.fqdn) ?? null;
  return { ok: Boolean(row), row, rows };
}

/** Delete a peer row on one node, tolerating a row that is already gone (removePeer deletes unconditionally). */
async function deletePeerRow(node, id) {
  return call(node, `${POOL}/peers/${id}`, { method: 'DELETE', timeoutMs: 30_000 });
}

/** The other node of the pair under test, and the row id this run recorded on `node` for it. */
function counterpart(ctx, node) {
  return node.label === 'core' ? { other: ctx.beta, ourRowId: ctx.state.peerIdOnCore } : { other: ctx.core, ourRowId: ctx.state.peerIdOnBeta };
}

/**
 * Split one node's `/peers` payload into the rows this test is entitled to touch and the rest.
 *
 * "The rest" is a pairing with some THIRD node, which this runner did not create and cannot
 * recreate: re-pairing needs a PIN minted on that node's screen or an approve action there
 * (hub-pool.controller.ts:216-228, :265-269). Deleting one would be a destructive request the plan's
 * teardown cannot reverse, so nothing here ever does.
 *
 * A row is in scope when it names the counterpart, or when this run created it. When the
 * counterpart's `nodeFqdn` is not known yet, NOTHING is in scope — attribution is impossible, and
 * failing closed is the only safe direction.
 */
function partitionPeerRows(ctx, node, rows) {
  const { other, ourRowId } = counterpart(ctx, node);
  const mine = [];
  const foreign = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const isOurs = (other.fqdn && row.nodeFqdn === other.fqdn) || (ourRowId && row.id === ourRowId) || ctx.state.createdPeerIds.has(row.id);
    (isOurs ? mine : foreign).push(row);
  }
  return { mine, foreign };
}

/** Just the in-scope rows, for the assertions that used to count every row on the node. */
const pairRows = (ctx, node, rows) => partitionPeerRows(ctx, node, rows).mine;

/**
 * Clear the pairing under test on both nodes.
 *
 * Always both sides: the unpair callback is HTTPS-only and best-effort, and its failure is swallowed
 * (hub-pool-peer.service.ts:994-1003), so trusting it leaves a stale row that answers later forwards
 * with 401 and makes every later pairing step 409.
 *
 * Scoped to the pair under test — see `partitionPeerRows`. Rows belonging to other nodes are counted
 * and reported, never deleted. `left` is deliberately NOT part of `problems`: a fleet where core is
 * also paired with a third node is a normal fleet, not a failed step.
 */
async function clearBothSides(ctx) {
  const cleared = [];
  const problems = [];
  const left = [];
  for (const node of [ctx.core, ctx.beta]) {
    if (!node.token || !node.hasPool) continue;
    const res = await getPeers(node);
    if (!res.ok) {
      problems.push(`${node.label}: ${httpSummary(res)}`);
      continue;
    }
    const { mine, foreign } = partitionPeerRows(ctx, node, res.json);
    if (foreign.length) {
      const preexisting = foreign.filter((row) => ctx.state.preexistingPeerIds[node.label]?.has(row.id)).length;
      left.push(`${node.label}: ${foreign.length} (${preexisting} already there before this run)`);
      // Without the counterpart's name, a row can only be attributed if this run created it, so say
      // so rather than letting the caller read an empty delete list as "already clean".
      if (!counterpart(ctx, node).other.fqdn) {
        problems.push(
          `${node.label}: ${foreign.length} peer row(s) could not be attributed — the counterpart’s nodeFqdn is unknown, so none of them was touched`,
        );
      }
    }
    for (const row of mine) {
      const deleted = await deletePeerRow(node, row.id);
      if (deleted.status === 200) {
        cleared.push(`${node.label}/${row.nodeFqdn}`);
        ctx.state.createdPeerIds.delete(row.id);
      } else problems.push(`${node.label}/${row.nodeFqdn}: ${httpSummary(deleted)}`);
    }
  }
  if (left.length) {
    const note = `refusing to delete pre-existing peer row(s) that are not part of this pair (${left.join(', ')}) — they belong to other nodes and this run cannot recreate them`;
    if (!ctx.state.notes.includes(note)) ctx.state.notes.push(note);
  }
  return { cleared, problems, left };
}

/** Why a per-row step cannot proceed: without core's name, no row on beta can be attributed to core. */
const UNATTRIBUTABLE =
  'core’s nodeFqdn is unknown (it is only on GET /status, which needs core’s operator credential), so no row on beta can be attributed to core — the runner will not act on a row it cannot identify';

/** Poll both nodes until each holds exactly one `connected` row with populated capabilities. */
async function waitForConnectedPair(ctx, seconds) {
  const budgetMs = (seconds * FRESHNESS_POLLS + PROBE_TIMEOUT_MS / 1000) * 1000;
  return until(
    async () => {
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      if (!core.ok || !beta.ok) return null;
      const corePeer = findPeerRow(core.json.peers, ctx.beta.fqdn) ?? core.json.peers?.[0];
      const betaPeer = findPeerRow(beta.json.peers, ctx.core.fqdn) ?? beta.json.peers?.[0];
      if (corePeer?.status !== 'connected' || betaPeer?.status !== 'connected') return null;
      return { core: core.json, beta: beta.json, corePeer, betaPeer };
    },
    { budgetMs, intervalMs: 3000 },
  );
}

const SECTION_2 = [
  {
    id: '2.1',
    title: 'Discovery lists the other node',
    on: 'core',
    wire: `GET ${POOL}/peers/discoverable`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await call(ctx.core, `${POOL}/peers/discoverable`, { timeoutMs: DISCOVERY_TIMEOUT_MS });
      if (!res.ok) return fail(httpSummary(res));
      const listed = (res.json ?? []).some((device) => device.nodeFqdn === ctx.beta.fqdn);
      if (listed) return pass(`beta listed (${(res.json ?? []).length} discoverable device(s))`);
      if (ctx.state.status.core?.tailscaleAdminApiConfigured !== true) {
        return blocked(
          'discovery unavailable: the Tailscale Admin API is not configured on core, so listDiscoverableDevices returns [] without probing',
        );
      }
      if (ctx.beta.httpsFqdn === false) {
        // hub-pool-peer.service.ts:326 probes https://<device.name> only, and a failure is silent.
        return blocked(
          'discovery cannot see beta: it probes https://<name> and no Tailscale cert is provisioned there — use pairing by address (2.8)',
        );
      }
      return fail(`beta (${ctx.beta.fqdn}) absent from ${(res.json ?? []).length} discoverable device(s)`);
    },
  },
  {
    id: '2.2a',
    title: 'Initiate pairing from core',
    on: 'core',
    wire: `POST ${POOL}/peers/pair`,
    tier: 'execute',
    would: 'POST /peers/pair on core (address+PIN when both nodes speak protocol 2, else nodeFqdn), creating one outbound pending row',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const existing = await getPeers(ctx.core);
      if (existing.status === 200 && (existing.json ?? []).length > 0) {
        const cleared = await clearBothSides(ctx);
        ctx.state.notes.push(`2.2a cleared pre-existing rows before pairing: ${cleared.cleared.join(', ') || 'none'}`);
      }
      const result = await initiatePairing(ctx);
      if (!result.ok) return fail(result.reason);
      const row = result.row ?? {};
      if (row.direction !== 'outbound' || row.status !== 'pending') {
        return fail(`row landed direction=${row.direction} status=${row.status}; a PIN authenticates the request, it does not stand in for approval`);
      }
      return pass(`${result.form.mode} form: outbound/pending row ${String(row.id).slice(0, 8)} for ${row.nodeFqdn}`);
    },
  },
  {
    id: '2.2b',
    title: 'Core holds exactly one outbound pending row',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getPeers(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const rows = res.json ?? [];
      if (rows.length === 0) return blocked('core holds no peer row (nothing has been paired in this run)');
      const outbound = rows.filter((row) => row.direction === 'outbound');
      if (outbound.length !== 1) return fail(`expected exactly one outbound row, found ${outbound.length}`);
      ctx.state.peerIdOnCore = outbound[0].id;
      if (outbound[0].status !== 'pending') return blocked(`row is '${outbound[0].status}', not 'pending' — 2.2b only applies before approval`);
      return pass(`one outbound/pending row ${String(outbound[0].id).slice(0, 8)} for ${outbound[0].nodeFqdn}`);
    },
  },
  {
    id: '2.3a',
    title: 'Beta shows the inbound pending request',
    on: 'beta',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const found = await inboundRowOnBeta(ctx);
      if (found.res && !found.res.ok) return fail(httpSummary(found.res));
      if (found.unattributable) return blocked(UNATTRIBUTABLE);
      if (!found.ok)
        return blocked('beta holds no row for core — nothing has been paired in this run, or the request never arrived (re-check 1.2b core->beta)');
      const row = found.row;
      ctx.state.peerIdOnBeta = row.id;
      ctx.state.createdPeerIds.add(row.id);
      if (row.direction !== 'inbound') return fail(`row for core is direction='${row.direction}', expected 'inbound'`);
      if (row.status !== 'pending') return blocked(`row is '${row.status}', not 'pending' — 2.3a only applies before approval`);
      return pass(`inbound/pending row ${String(row.id).slice(0, 8)} from ${row.nodeFqdn}`);
    },
  },
  {
    id: '2.3b',
    title: 'Approve on beta',
    on: 'beta',
    wire: `POST ${POOL}/peers/{id}/approve`,
    tier: 'execute',
    would: 'POST /peers/<inbound row id>/approve on beta, flipping that row to connected and firing the confirm callback to core',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const found = await inboundRowOnBeta(ctx);
      if (found.unattributable) return blocked(UNATTRIBUTABLE);
      if (!found.ok) return blocked('no inbound row on beta to approve');
      const res = await call(ctx.beta, `${POOL}/peers/${found.row.id}/approve`, { method: 'POST', body: {}, timeoutMs: 30_000 });
      if (!res.ok) return fail(httpSummary(res));
      if (res.json?.status !== 'connected') return fail(`approve returned status='${res.json?.status}', expected 'connected'`);
      if ('verifyTokenHash' in (res.json ?? {}) || 'presentTokenEncrypted' in (res.json ?? {}))
        return fail('approve leaked a token column into the response');
      ctx.state.peerIdOnBeta = res.json.id;
      ctx.state.createdPeerIds.add(res.json.id);
      return pass(
        `beta row ${String(res.json.id).slice(0, 8)} is connected; the confirm callback to core is fired after this write and is not rolled back if it fails`,
      );
    },
  },
  {
    id: '2.4',
    title: 'Both sides report connected, each holding its half',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const first = await getStatus(ctx.core);
      if (!first.ok) return fail(httpSummary(first));
      if ((first.json.peers ?? []).length === 0) return blocked('core holds no peer row — nothing has been paired in this run');
      const seconds = pollSeconds(first.json);
      const settled = await waitForConnectedPair(ctx, seconds);
      if (!settled) {
        const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
        const coreRow = core.json?.peers?.[0];
        const betaRow = beta.json?.peers?.[0];
        const stuck = `core=${coreRow?.status ?? 'none'} beta=${betaRow?.status ?? 'none'}`;
        if (ctx.core.httpsFqdn === false || ctx.beta.httpsFqdn === false) {
          return blocked(
            `${stuck} after ${seconds * FRESHNESS_POLLS}s — the approve confirm callback is https://<fqdn> only and no cert is provisioned; not a Hub Pool defect`,
          );
        }
        return fail(`${stuck} after ${seconds * FRESHNESS_POLLS}s; one direction of the handshake is not completing`);
      }
      const problems = [];
      for (const [label, status, peer] of [
        ['core', settled.core, settled.corePeer],
        ['beta', settled.beta, settled.betaPeer],
      ]) {
        const counts = status.peerCounts ?? {};
        if (counts.connected !== 1 || counts.pending !== 0 || counts.unreachable !== 0)
          problems.push(`${label} peerCounts ${JSON.stringify(counts)}`);
        if (status.routingActive !== true) problems.push(`${label} routingActive=false (reason '${status.reason}')`);
        const backends = peer.lastCapabilities?.backends ?? [];
        if (!backends.some((backend) => backend.healthy === true)) {
          problems.push(`${label} peer lastCapabilities has no healthy backend (lastSeenAt ${peer.lastSeenAt ?? 'never'})`);
        }
      }
      if (problems.length) return fail(problems.join('; '));
      ctx.state.peerIdOnCore = settled.corePeer.id;
      ctx.state.peerIdOnBeta = settled.betaPeer.id;
      ctx.state.pollSeconds = pollSeconds(settled.core);
      return pass(`both connected, engines populated on both sides (poll ${ctx.state.pollSeconds}s)`);
    },
  },
  {
    id: '2.5a',
    title: 'Reject path 1/4: clear the existing row on core (and beta’s counterpart)',
    on: 'core',
    wire: `DELETE ${POOL}/peers/{id}`,
    tier: 'execute',
    would: 'DELETE the peer row on core AND on beta (the unpair callback is HTTPS-only and best-effort, so both sides are cleared explicitly)',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      ctx.state.priorPeerIds = { core: ctx.state.peerIdOnCore, beta: ctx.state.peerIdOnBeta };
      const cleared = await clearBothSides(ctx);
      if (cleared.problems.length) return fail(cleared.problems.join('; '));
      const [core, beta] = await Promise.all([getPeers(ctx.core), getPeers(ctx.beta)]);
      // Scoped to the pair under test: a row for some THIRD node is untouched by design, and its
      // presence is not this step's subject.
      const survivors = pairRows(ctx, ctx.core, core.json).length + pairRows(ctx, ctx.beta, beta.json).length;
      ctx.state.paired = false;
      return survivors === 0
        ? pass(`cleared ${cleared.cleared.length} row(s); neither side holds a row for the other`)
        : fail(`rows survived: ${survivors} row(s) still name the counterpart`);
    },
  },
  {
    id: '2.5b',
    title: 'Reject path 2/4: initiate pairing again from core',
    on: 'core',
    wire: `POST ${POOL}/peers/pair`,
    tier: 'execute',
    would: 'POST /peers/pair on core again (minting a fresh PIN on beta first when the address form is in use — a PIN is single-use)',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const result = await initiatePairing(ctx);
      if (!result.ok) return fail(result.reason);
      // 2.5d deletes a stranded row only when it is one of these — the row this run just created.
      ctx.state.rejectPath = { pairedAt: Date.now(), rowIdOnCore: result.row?.id ?? null, rejected: false };
      return pass(`${result.form.mode} form: outbound/pending row ${String(result.row?.id).slice(0, 8)}`);
    },
  },
  {
    id: '2.5c',
    title: 'Reject path 3/4: reject on beta',
    on: 'beta',
    wire: `POST ${POOL}/peers/{id}/reject`,
    tier: 'execute',
    would: 'POST /peers/<inbound row id>/reject on beta, deleting beta’s row and firing the authenticated reject callback to core',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const found = await inboundRowOnBeta(ctx);
      if (found.unattributable) return blocked(UNATTRIBUTABLE);
      if (!found.ok) return blocked('no inbound row on beta to reject');
      const res = await call(ctx.beta, `${POOL}/peers/${found.row.id}/reject`, { method: 'POST', body: {}, timeoutMs: 30_000 });
      if (!res.ok) return fail(httpSummary(res));
      if (ctx.state.rejectPath) ctx.state.rejectPath.rejected = true;
      return res.json?.success === true ? pass('beta rejected and deleted its row') : fail(`reject returned ${JSON.stringify(res.json)}`);
    },
  },
  {
    id: '2.5d',
    title: 'Reject path 4/4: both sides hold no rows',
    on: 'both',
    wire: `GET ${POOL}/peers`,
    // Read-only in the ordinary sense: it observes. The ONE write it can make — deleting a row
    // stranded by a failed reject callback — is confined to the row 2.5b created in this session and
    // needs --execute, because a `pending` row on core is also what an operator's own outstanding
    // pairing request looks like, and nothing in section 10 can mint a replacement PIN for them.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const flow = ctx.state.rejectPath;
      if (!flow?.rejected) {
        return blocked(
          'the reject path did not run in this session (2.5a-2.5c need --execute), so there is no reject to observe — any rows on either node predate this run and are left exactly as they are',
        );
      }
      const settled = await until(
        async () => {
          const [core, beta] = await Promise.all([getPeers(ctx.core), getPeers(ctx.beta)]);
          if (!core.ok || !beta.ok) return null;
          return pairRows(ctx, ctx.core, core.json).length === 0 && pairRows(ctx, ctx.beta, beta.json).length === 0 ? { core, beta } : null;
        },
        { budgetMs: 10_000, intervalMs: 2000 },
      );
      if (settled) {
        ctx.state.paired = false;
        return pass('neither side holds a row for the other within 10s of the reject');
      }
      const core = await getPeers(ctx.core);
      // Only the row 2.5b created. A `pending` row the runner did not create belongs to an operator
      // (an outbound request they made, or an inbound one awaiting their approval) and is not ours.
      const stranded = pairRows(ctx, ctx.core, core.json).filter(
        (row) => row.status === 'pending' && (!flow.rowIdOnCore || row.id === flow.rowIdOnCore),
      );
      // Survivable per the doc, but it MUST be recorded — and cleaned up, or every later pairing 409s.
      if (stranded.length) {
        let disposition;
        if (ctx.opts.execute) {
          for (const row of stranded) await deletePeerRow(ctx.core, row.id);
          disposition = `Runner deleted the ${stranded.length} row(s) it created so later steps do not 409.`;
        } else {
          disposition = `Runner left ${stranded.length} row(s) in place (re-run with --execute to clear them).`;
        }
        const attribution =
          ctx.core.httpsFqdn === false
            ? 'the reject callback is https://<core fqdn> only and no cert is provisioned'
            : 'the authenticated reject callback to core failed';
        return fail(`core kept ${stranded.length} stranded pending row(s) after 10s — ${attribution}. ${disposition}`);
      }
      return fail('rows for the counterpart survived the reject on one side and are not pending');
    },
  },
  {
    id: '2.6a',
    title: 'Re-pair after an unpair: initiate on core',
    on: 'core',
    wire: `POST ${POOL}/peers/pair`,
    tier: 'execute',
    would: 'POST /peers/pair on core after the reject path, proving a rejected pairing can be re-established',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const result = await initiatePairing(ctx);
      if (result.ok) return pass(`${result.form.mode} form: outbound/pending row ${String(result.row?.id).slice(0, 8)}`);
      if (result.res?.status === 409) {
        // Different defect from 2.2a's: a stale row the reject path left behind.
        const cleared = await clearBothSides(ctx);
        const retry = await initiatePairing(ctx);
        return fail(
          `409 Already paired — 2.5 left a row behind. Runner cleared ${cleared.cleared.length} row(s) and retried: ${retry.ok ? 'retry succeeded' : retry.reason}`,
        );
      }
      return fail(result.reason);
    },
  },
  {
    id: '2.6b',
    title: 'Re-pair after an unpair: approve on beta',
    on: 'beta',
    wire: `POST ${POOL}/peers/{id}/approve`,
    tier: 'execute',
    would: 'POST /peers/<new inbound row id>/approve on beta (a NEW uuid — the row from 2.3a is gone)',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const found = await inboundRowOnBeta(ctx);
      if (found.unattributable) return blocked(UNATTRIBUTABLE);
      if (!found.ok) return blocked('no inbound row on beta to approve');
      const res = await call(ctx.beta, `${POOL}/peers/${found.row.id}/approve`, { method: 'POST', body: {}, timeoutMs: 30_000 });
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.peerIdOnBeta = res.json?.id ?? null;
      if (res.json?.id) ctx.state.createdPeerIds.add(res.json.id);
      return res.json?.status === 'connected'
        ? pass(`re-approved: row ${String(res.json.id).slice(0, 8)} connected`)
        : fail(`status='${res.json?.status}'`);
    },
  },
  {
    id: '2.6c',
    title: 'Re-pair after an unpair: both sides connected with fresh rows',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const settled = await waitForConnectedPair(ctx, seconds);
      if (!settled) return fail(`not both connected within ${seconds * FRESHNESS_POLLS}s`);
      ctx.state.peerIdOnCore = settled.corePeer.id;
      ctx.state.peerIdOnBeta = settled.betaPeer.id;
      const prior = ctx.state.priorPeerIds ?? {};
      const fresh = settled.corePeer.id !== prior.core && settled.betaPeer.id !== prior.beta;
      return fresh
        ? pass('both connected, and both row ids differ from the pre-2.5a pair (fresh rows, hence fresh tokens)')
        : fail(
            `row ids unchanged across the unpair (core ${String(settled.corePeer.id).slice(0, 8)}, beta ${String(settled.betaPeer.id).slice(0, 8)})`,
          );
    },
  },
  {
    id: '2.7a',
    title: 'The bearer to signed upgrade, observed on both sides',
    on: 'both',
    wire: `GET ${POOL}/status (peers[].authMode)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const settled = await until(
        async () => {
          const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
          if (!core.ok || !beta.ok) return null;
          const rows = [...(core.json.peers ?? []), ...(beta.json.peers ?? [])];
          if (rows.length === 0) return null;
          return rows.every((row) => row.authMode === 'signed' && row.peerKeyFingerprint) ? { core: core.json, beta: beta.json } : null;
        },
        { budgetMs: seconds * FRESHNESS_POLLS * 1000, intervalMs: 3000 },
      );
      if (settled) {
        const fingerprints = [...(settled.core.peers ?? []), ...(settled.beta.peers ?? [])].map((row) => row.peerKeyFingerprint);
        return pass(`every peer row on both nodes is authMode='signed' with a pinned key (${fingerprints.join(', ')})`);
      }
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      const rows = [...(core.json?.peers ?? []).map((row) => ['core', row]), ...(beta.json?.peers ?? []).map((row) => ['beta', row])];
      if (rows.length === 0) return blocked('no peer rows on either node — nothing has been paired in this run');
      const bearer = rows
        .filter(([, row]) => row.authMode !== 'signed')
        .map(([label, row]) => `${label}:${row.nodeFqdn} authMode=${row.authMode ?? 'absent'}`);
      return fail(`still on bearer after ${seconds * FRESHNESS_POLLS}s: ${bearer.join(', ')}`);
    },
  },
  {
    id: '2.7b',
    title: 'Force the bearer to signed exchange now, instead of waiting for the poll',
    on: 'both',
    wire: `POST ${POOL}/peers/{id}/upgrade`,
    tier: 'execute',
    would: 'POST /peers/<id>/upgrade on each node. IRREVERSIBLE in one respect: the pairing survives, the retired bearer token does not.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const lines = [];
      let failed = false;
      for (const [node, idKey] of [
        [ctx.core, 'peerIdOnCore'],
        [ctx.beta, 'peerIdOnBeta'],
      ]) {
        const id = ctx.state[idKey];
        if (!id) {
          lines.push(`${node.label}: no peer row id known`);
          continue;
        }
        const res = await call(node, `${POOL}/peers/${id}/upgrade`, { method: 'POST', body: {}, timeoutMs: 30_000 });
        if (!res.ok) {
          failed = true;
          lines.push(
            `${node.label}: ${res.status === 500 ? 'HTTP 500 (transport failure; message swallowed by the exception filter)' : httpSummary(res)}`,
          );
          continue;
        }
        const pinned = Boolean(res.json?.peerNodeUuid) && Boolean(res.json?.peerPublicKey);
        if (!pinned) failed = true;
        lines.push(
          `${node.label}: peerNodeUuid=${res.json?.peerNodeUuid ? 'set' : 'null'} peerPublicKey=${res.json?.peerPublicKey ? 'set' : 'null'}`,
        );
      }
      return failed ? fail(lines.join(' | ')) : pass(lines.join(' | '));
    },
  },
  {
    id: '2.7c',
    title: 'The retired bearer credential is gone from the database',
    on: 'both',
    wire: 'no HTTP surface — toPublicPeer strips both token columns by design',
    tier: 'readonly',
    manualAction:
      'On each node: docker exec ci-hub-db psql -c "select peer_node_uuid, verify_token_hash, present_token_encrypted, signed_seen_at from hub_pool_peer;" — expect both token columns NULL on every pinned row.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const observations = [];
      for (const node of [ctx.core, ctx.beta]) {
        const res = await getPeers(node);
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        for (const row of res.json ?? []) {
          if ('verifyTokenHash' in row || 'presentTokenEncrypted' in row) return fail(`${node.label}: a token column leaked onto GET /peers`);
          observations.push(`${node.label} peerNodeUuid=${row.peerNodeUuid ? 'set' : 'null'} signedSeenAt=${row.signedSeenAt ? 'set' : 'null'}`);
        }
      }
      if (observations.length === 0) return blocked('no peer rows to inspect');
      return manual(
        `automatable half PASSES (token columns absent from /peers; ${observations.join('; ')}). The two token-NULL columns need psql on each node.`,
      );
    },
  },
  {
    id: '2.8a',
    title: 'PIN pairing 1/6: clear any existing row on core and beta',
    on: 'core',
    wire: `DELETE ${POOL}/peers/{id}`,
    tier: 'execute',
    would: 'DELETE every peer row on both nodes so the PIN pairing starts from empty',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const cleared = await clearBothSides(ctx);
      ctx.state.paired = false;
      if (cleared.problems.length) return fail(cleared.problems.join('; '));
      const [core, beta] = await Promise.all([getPeers(ctx.core), getPeers(ctx.beta)]);
      const empty = (core.json ?? []).length === 0 && (beta.json ?? []).length === 0;
      return empty ? pass(`cleared ${cleared.cleared.length} row(s) on both sides`) : fail('rows survived on one side');
    },
  },
  {
    id: '2.8b',
    title: 'PIN pairing 2/6: mint a pairing PIN on beta',
    on: 'beta',
    wire: `POST ${POOL}/pairing-pin`,
    tier: 'execute',
    would: 'POST /pairing-pin on beta. The digits are returned exactly once and are held in memory only — never logged, never written to disk.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const minted = await mintPin(ctx, ctx.beta);
      if (!minted.ok) {
        const detail =
          minted.res.status === 503 ? 'HTTP 503 — pooling is disabled on beta, so no pairing surface will work' : httpSummary(minted.res);
        return fail(detail);
      }
      if (!/^\d{6}$/.test(minted.pin)) return fail('minted value is not exactly six digits');
      ctx.state.lastPin = minted.pin;
      ctx.state.lastPinMintedAt = Date.now();
      ctx.state.betaFingerprint = minted.fingerprint;
      if (minted.identityError)
        return fail(`identityError: ${minted.identityError} — beta cannot pin an identity, so PIN pairing will not produce a signed pairing`);
      const status = await getStatus(ctx.beta);
      const pinState = status.json?.pairingPin;
      if (pinState && pinState.active !== true) return fail('/status does not report pairingPin.active === true after minting');
      if (status.text?.includes(minted.pin)) return fail('/status leaked the PIN digits');
      return pass(
        `6-digit PIN minted (expires ${minted.expiresAt}); /status reports it active without the digits; beta fingerprint ${minted.fingerprint ?? '-'}`,
      );
    },
  },
  {
    id: '2.8c',
    title: 'PIN pairing 3/6: pair from core using the PIN',
    on: 'core',
    wire: `POST ${POOL}/peers/pair {address, pin}`,
    tier: 'execute',
    would: 'POST /peers/pair on core with beta’s address and the PIN from 2.8b',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta), protocolGate(ctx.core, ctx.beta));
      if (stop) return stop;
      if (!ctx.state.lastPin) return blocked('no PIN outstanding — 2.8b did not run');
      const res = await call(ctx.core, `${POOL}/peers/pair`, {
        method: 'POST',
        body: { address: ctx.beta.probeAddress, pin: ctx.state.lastPin, displayName: 'pool-qa beta' },
        timeoutMs: 30_000,
      });
      ctx.state.lastPin = null;
      if (!res.ok) {
        const detail =
          res.status === 500 ? 'HTTP 500 INTERNAL_SERVER_ERROR — the PIN was refused; the real text is only in core’s logs' : httpSummary(res);
        return fail(detail);
      }
      ctx.state.paired = true;
      ctx.state.peerIdOnCore = res.json?.id ?? null;
      const row = res.json ?? {};
      if (row.status === 'connected') {
        return fail(
          'row landed CONNECTED with no approval — a PIN authenticates the request and must never stand in for the operator seeing who is asking',
        );
      }
      if (row.status !== 'pending') return fail(`row landed status='${row.status}', expected 'pending'`);
      if (!row.peerNodeUuid || !row.peerPublicKey)
        return fail(
          `identity was not pinned during the PIN exchange (peerNodeUuid=${row.peerNodeUuid}, peerPublicKey=${row.peerPublicKey ? 'set' : 'null'})`,
        );
      if (ctx.beta.fqdn && row.nodeFqdn !== ctx.beta.fqdn)
        return fail(`row keyed on '${row.nodeFqdn}', but beta reports its own name as '${ctx.beta.fqdn}'`);
      return pass(
        `outbound/pending row ${String(row.id).slice(0, 8)} keyed on ${row.nodeFqdn} (name learned from beta’s PIN-authenticated reply), identity pinned`,
      );
    },
  },
  {
    id: '2.8d',
    title: 'PIN pairing 4/6: fingerprints match across both nodes, and the row is still pending',
    on: 'both',
    wire: `GET ${POOL}/status (peers[].peerKeyFingerprint vs localNode.identity.publicKeyFingerprint)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      if (!core.ok || !beta.ok) return fail(`core ${httpSummary(core)} / beta ${httpSummary(beta)}`);
      const coreRow = findPeerRow(core.json.peers, ctx.beta.fqdn) ?? core.json.peers?.[0];
      const betaRow = findPeerRow(beta.json.peers, ctx.core.fqdn) ?? beta.json.peers?.[0];
      if (!coreRow || !betaRow) return blocked(`missing a peer row (core ${coreRow ? 'ok' : 'none'}, beta ${betaRow ? 'ok' : 'none'})`);
      const problems = [];
      if (coreRow.status === 'connected' || betaRow.status === 'connected')
        problems.push('a row is already connected — the PIN stood in for approval');
      const coreOwn = core.json.localNode?.identity?.publicKeyFingerprint ?? null;
      const betaOwn = beta.json.localNode?.identity?.publicKeyFingerprint ?? null;
      if (!coreRow.peerKeyFingerprint || !betaRow.peerKeyFingerprint)
        problems.push('a peerKeyFingerprint is null — the PIN did not reach the identity path');
      if (coreRow.peerKeyFingerprint !== betaOwn) problems.push(`core sees beta as ${coreRow.peerKeyFingerprint}, beta reports ${betaOwn}`);
      if (betaRow.peerKeyFingerprint !== coreOwn) problems.push(`beta sees core as ${betaRow.peerKeyFingerprint}, core reports ${coreOwn}`);
      if (problems.length) return fail(problems.join('; '));
      return pass(
        `fingerprints match in both directions (core sees ${coreRow.peerKeyFingerprint}, beta sees ${betaRow.peerKeyFingerprint}); both rows still pending`,
      );
    },
  },
  {
    id: '2.8e',
    title: 'PIN pairing 5/6: approve on beta',
    on: 'beta',
    wire: `POST ${POOL}/peers/{id}/approve`,
    tier: 'execute',
    would: 'POST /peers/<inbound row id>/approve on beta to complete the PIN pairing',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const found = await inboundRowOnBeta(ctx);
      if (found.unattributable) return blocked(UNATTRIBUTABLE);
      if (!found.ok) return blocked('no inbound row on beta to approve');
      const res = await call(ctx.beta, `${POOL}/peers/${found.row.id}/approve`, { method: 'POST', body: {}, timeoutMs: 30_000 });
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.peerIdOnBeta = res.json?.id ?? null;
      if (res.json?.id) ctx.state.createdPeerIds.add(res.json.id);
      return res.json?.status === 'connected' ? pass(`row ${String(res.json.id).slice(0, 8)} connected`) : fail(`status='${res.json?.status}'`);
    },
  },
  {
    id: '2.8f',
    title: 'PIN pairing 6/6: both sides connected and SIGNED immediately, with no upgrade poll',
    on: 'both',
    wire: `GET ${POOL}/status (peers[].authMode on the FIRST read)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      // Asserting immediacy IS the test — no polling for authMode here.
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      if (!core.ok || !beta.ok) return fail(`core ${httpSummary(core)} / beta ${httpSummary(beta)}`);
      const rows = [
        ['core', core.json.peers?.[0]],
        ['beta', beta.json.peers?.[0]],
      ];
      if (rows.some(([, row]) => !row)) return blocked('a peer row is missing');
      const bearer = rows.filter(([, row]) => row.authMode !== 'signed').map(([label, row]) => `${label} authMode=${row.authMode ?? 'absent'}`);
      if (bearer.length) return fail(`${bearer.join(', ')} on the first read — the whole point of the PIN path is that it skips the bearer window`);
      const notConnected = rows.filter(([, row]) => row.status !== 'connected').map(([label, row]) => `${label} status=${row.status}`);
      if (notConnected.length) return fail(notConnected.join(', '));
      return pass('both rows connected AND authMode=signed on the first read — the identity was pinned during the PIN exchange');
    },
  },
  {
    id: '2.9a',
    title: 'Wrong PIN 1/4: mint a fresh PIN on beta and do not use it',
    on: 'beta',
    wire: `POST ${POOL}/pairing-pin`,
    tier: 'execute',
    would: 'unpair both sides, then POST /pairing-pin on beta so a PIN is outstanding for the wrong-guess test',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      await clearBothSides(ctx);
      ctx.state.paired = false;
      const minted = await mintPin(ctx, ctx.beta);
      if (!minted.ok) return fail(minted.res.status === 503 ? 'HTTP 503 — pooling disabled on beta' : httpSummary(minted.res));
      ctx.state.outstandingPinExists = true;
      return pass('a fresh PIN is outstanding on beta; its digits are discarded — the point is only that one exists');
    },
  },
  {
    id: '2.9b',
    title: 'Wrong PIN 2/4: a wrong guess creates nothing',
    on: 'core',
    wire: `POST ${POOL}/peers/pair {address, pin:"000000"}`,
    tier: 'execute',
    would: 'POST /peers/pair on core with a deliberately wrong PIN, expecting a non-2xx and no row on either side',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta), protocolGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const res = await call(ctx.core, `${POOL}/peers/pair`, {
        method: 'POST',
        body: { address: ctx.beta.probeAddress, pin: '000000' },
        timeoutMs: 30_000,
      });
      if (res.status >= 200 && res.status < 300) {
        await clearBothSides(ctx);
        return fail(`core accepted a wrong PIN (HTTP ${res.status}); runner cleared the resulting rows`);
      }
      const [core, beta] = await Promise.all([getPeers(ctx.core), getPeers(ctx.beta)]);
      // Scoped to the pair: a pairing with some third node is not something a wrong PIN created.
      const rows = pairRows(ctx, ctx.core, core.json).length + pairRows(ctx, ctx.beta, beta.json).length;
      if (rows !== 0) {
        await clearBothSides(ctx);
        return fail(`a wrong PIN left ${rows} row(s) behind; runner cleared them`);
      }
      // The doc says "401 Invalid or expired pairing PIN". That is BETA's answer on its own
      // /pair/request; core's operator API answers 500 with the message swallowed.
      const note =
        res.status === 500
          ? 'core answered HTTP 500 INTERNAL_SERVER_ERROR (the actionable text is written but never delivered — reportable usability defect)'
          : `core answered HTTP ${res.status}`;
      return pass(`${note}; no row on either side`);
    },
  },
  {
    id: '2.9c',
    title: 'Wrong PIN 3/4: beta has no row at all',
    on: 'beta',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getPeers(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const forCore = (res.json ?? []).filter((row) => row.nodeFqdn === ctx.core.fqdn);
      if (forCore.length === 0) return pass(`beta holds no row for core (${(res.json ?? []).length} row(s) total)`);
      return ctx.state.paired
        ? blocked('beta holds a row for core, but this run has an active pairing — 2.9c only applies right after a wrong-PIN attempt')
        : fail('a wrong PIN created a pending slot on beta');
    },
  },
  {
    id: '2.9d',
    title: 'Wrong PIN 4/4: uniform error text, and the per-source cooldown on the THIRD attempt',
    on: 'beta',
    wire: `POST ${POOL}/pair/request (unauthenticated write)`,
    tier: 'hazard',
    flag: 'wrongPin',
    flagName: '--wrong-pin',
    would:
      'POST /pair/request on beta three times with a SYNTHETIC claimed name and a wrong PIN, expecting 401, 401, 429. HAZARD: withholds that source for 60s, doubling to 15min on repeat.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta));
      if (stop) return stop;
      // Synthetic claimed name, never core's: the cooldown is keyed on the CLAIMED fromNodeFqdn as
      // well as the source IP, so using core's real name would poison every later PIN step for core.
      const suffix = (ctx.beta.fqdn ?? 'example-tailnet.ts.net').split('.').slice(1).join('.') || 'example-tailnet.ts.net';
      const synthetic = `pool-qa-synthetic-${Date.now().toString(36)}.${suffix}`;
      const token = 'a'.repeat(48);
      const attempts = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await call(ctx.beta, `${POOL}/pair/request`, {
          method: 'POST',
          auth: 'none',
          body: { fromNodeFqdn: synthetic, token, pin: '000001' },
        });
        attempts.push({ attempt, status: res.status, message: errorText(res) });
      }
      ctx.state.pinCooldownUntil = Date.now() + 60_000;
      const after = await getPeers(ctx.beta);
      if (after.status === 200 && (after.json ?? []).some((row) => row.nodeFqdn === synthetic))
        return fail('a wrong PIN created a row for the synthetic claimed name');
      const problems = [];
      if (attempts[0].status !== 401 || attempts[1].status !== 401)
        problems.push(`attempts 1-2 were ${attempts[0].status}/${attempts[1].status}, expected 401/401`);
      if (attempts[0].message !== attempts[1].message)
        problems.push(`error text differs between attempts ("${attempts[0].message}" vs "${attempts[1].message}") — that is a searchable oracle`);
      if (attempts[0].message !== PIN_FAILURE_MESSAGE) problems.push(`message was "${attempts[0].message}", expected "${PIN_FAILURE_MESSAGE}"`);
      if (attempts[2].status !== 429)
        problems.push(`attempt 3 was ${attempts[2].status}, expected 429 (ServingQuarantine strikes at 2, checked BEFORE the PIN comparison)`);
      const rendered = attempts.map((row) => `${row.attempt}:${row.status}`).join(' ');
      return problems.length
        ? fail(`${rendered} — ${problems.join('; ')}`)
        : pass(`${rendered} with byte-identical 401 text; no row created; source now in cooldown for >=60s`);
    },
  },
  {
    id: '2.9e',
    title: 'Wrong PIN extra: a PIN is single use',
    on: 'core',
    wire: `POST ${POOL}/peers/pair (replaying digits already consumed)`,
    tier: 'execute',
    would: 'mint a PIN on beta, pair with it, unpair both sides, then replay the SAME digits — expecting the replay to be refused',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta), protocolGate(ctx.core, ctx.beta));
      if (stop) return stop;
      if (ctx.state.pinCooldownUntil && Date.now() < ctx.state.pinCooldownUntil) {
        const waitMs = ctx.state.pinCooldownUntil - Date.now();
        ctx.state.notes.push(`2.9e waited ${Math.ceil(waitMs / 1000)}s for the 2.9d per-source cooldown to lapse`);
        await sleep(waitMs);
      }
      await clearBothSides(ctx);
      const minted = await mintPin(ctx, ctx.beta);
      if (!minted.ok) return fail(`could not mint: ${httpSummary(minted.res)}`);
      const first = await call(ctx.core, `${POOL}/peers/pair`, {
        method: 'POST',
        body: { address: ctx.beta.probeAddress, pin: minted.pin },
        timeoutMs: 30_000,
      });
      if (!first.ok) return blocked(`the PIN pairing this step replays did not succeed in the first place: ${httpSummary(first)}`);
      ctx.state.paired = true;
      await clearBothSides(ctx);
      ctx.state.paired = false;
      const replay = await call(ctx.core, `${POOL}/peers/pair`, {
        method: 'POST',
        body: { address: ctx.beta.probeAddress, pin: minted.pin },
        timeoutMs: 30_000,
      });
      if (replay.status >= 200 && replay.status < 300) {
        await clearBothSides(ctx);
        return fail('the replayed PIN paired a second time — a PIN read aloud or seen in a screenshot must not pair another node');
      }
      const beta = await getPeers(ctx.beta);
      if (pairRows(ctx, ctx.beta, beta.json).length !== 0) {
        await clearBothSides(ctx);
        return fail('the replay left a row on beta');
      }
      // Minted under 10 minutes ago, so PAIRING_PIN_TTL_MS cannot be the reason it was refused.
      const ageSeconds = Math.round((Date.now() - minted.mintedAt) / 1000);
      return pass(
        `replay refused (HTTP ${replay.status}) and beta gained no row; the PIN was minted ${ageSeconds}s ago (TTL 600s), so 'expired' is excluded`,
      );
    },
  },
  {
    id: '2.10',
    title: 'A renamed node keeps routing',
    on: 'core',
    wire: 'Tailscale admin console — no HTTP route in this repo renames a tailnet device',
    tier: 'readonly',
    manualAction:
      'Rename the beta node in the Tailscale admin console, wait for MagicDNS to propagate, then re-run --only 2.10 to check the AFTER assertions.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getStatus(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const row = res.json.peers?.[0];
      if (!row) return blocked('core holds no peer row to capture a BEFORE snapshot from');
      // A bearer-only pairing cannot survive a rename — the precondition must be proven, not assumed.
      if (row.authMode !== 'signed' || !row.peerNodeUuid) {
        return blocked(
          `precondition unmet: peer is authMode='${row.authMode ?? 'absent'}' with peerNodeUuid=${row.peerNodeUuid ?? 'null'} — a bearer-only pairing cannot survive a rename`,
        );
      }
      const before = {
        id: row.id,
        nodeFqdn: row.nodeFqdn,
        peerNodeUuid: row.peerNodeUuid,
        lastSeenAt: row.lastSeenAt,
        consecutiveFailures: row.consecutiveFailures,
      };
      const prior = ctx.state.renameBefore;
      ctx.state.renameBefore = before;
      if (!prior) {
        return manual(
          `BEFORE captured: id ${String(before.id).slice(0, 8)}, fqdn ${before.nodeFqdn}, uuid pinned, failures ${before.consecutiveFailures}. Rename beta, then re-run this step.`,
        );
      }
      const problems = [];
      if (before.id !== prior.id) problems.push(`peer row id changed (${String(prior.id).slice(0, 8)} -> ${String(before.id).slice(0, 8)})`);
      if (before.peerNodeUuid !== prior.peerNodeUuid) problems.push('peerNodeUuid changed');
      if (before.nodeFqdn === prior.nodeFqdn) problems.push(`nodeFqdn did not change (${before.nodeFqdn}) — the rename has not propagated`);
      if (before.consecutiveFailures !== 0) problems.push(`consecutiveFailures=${before.consecutiveFailures}`);
      return problems.length
        ? fail(problems.join('; '))
        : pass(`same row id and pinned uuid across the rename ${prior.nodeFqdn} -> ${before.nodeFqdn}, failures 0`);
    },
  },
  {
    id: '2.11',
    title: 'Identity rotation unpairs, and says who it could not tell',
    on: 'core',
    wire: `POST ${POOL}/identity/rotate`,
    tier: 'hazard',
    flag: 'rotateIdentity',
    flagName: '--rotate-identity',
    would:
      'POST /identity/rotate on core. HAZARD: unpairs EVERY peer on that node, not only beta, and destroys the old keypair. Recovery is re-pairing plus a manual DELETE on any peer that landed in `unreachable`.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const before = await getStatus(ctx.core);
      if (!before.ok) return fail(httpSummary(before));
      const identity = before.json.localNode?.identity ?? {};
      const res = await call(ctx.core, `${POOL}/identity/rotate`, { method: 'POST', body: {}, timeoutMs: 60_000 });
      ctx.state.paired = false;
      if (!res.ok) return fail(httpSummary(res));
      const rotated = res.json ?? {};
      const problems = [];
      if (rotated.nodeUuid !== identity.nodeUuid)
        problems.push(`nodeUuid changed (${identity.nodeUuid} -> ${rotated.nodeUuid}) — rotation keeps the UUID, only the keypair moves`);
      if (rotated.publicKeyFingerprint === identity.publicKeyFingerprint)
        problems.push('publicKeyFingerprint is unchanged — the keypair did not move');
      const [core, beta] = await Promise.all([getPeers(ctx.core), getPeers(ctx.beta)]);
      // Rotation unpairs EVERY peer on core; this step only judges the pair under test, because a
      // third node's row is one this runner never created and must not reason about.
      const coreRows = pairRows(ctx, ctx.core, core.json);
      const betaRows = pairRows(ctx, ctx.beta, beta.json);
      if (coreRows.length !== 0) problems.push(`core still holds ${coreRows.length} row(s) for beta`);
      if (betaRows.length !== 0) {
        const attribution =
          (rotated.unreachable ?? []).length > 0
            ? 'beta appeared in `unreachable`, which is expected on a cert-less fleet'
            : 'beta was reachable and should have been told';
        problems.push(`beta still holds ${betaRows.length} row(s) for core — ${attribution}`);
        await clearBothSides(ctx);
      }
      const summary = `unpaired=[${(rotated.unpaired ?? []).join(', ')}] unreachable=[${(rotated.unreachable ?? []).join(', ')}]`;
      return problems.length ? fail(`${summary}; ${problems.join('; ')}`) : pass(`${summary}; same nodeUuid, new fingerprint, both sides empty`);
    },
  },
];
// ─────────────────────────────────────────────────────────────────────────────
// Steps — sections 3 and 4: routing and load handoff
//
// The arithmetic under test throughout: score(local) = localInFlight + weight*pressure;
// score(peer) = max(forwardedToPeer, peerSelfReport) + weight*pressure + poolLocalAffinity, with
// exact ties broken by LOCAL_TIER_RANK = -1 (hub-pool-proxy.service.ts:230-247, :44, :57). Every
// expectation below is that formula with the DEFAULT settings, so a node tuned differently is
// reported BLOCKED rather than FAIL — the prediction is wrong, not the code.
// ─────────────────────────────────────────────────────────────────────────────

/** Read core's status and pull out the one peer row plus the settings the ranker uses. */
async function routingContext(ctx) {
  const res = await getStatus(ctx.core);
  if (!res.ok) return { error: httpSummary(res) };
  const status = res.json;
  const peer = findPeerRow(status.peers, ctx.beta.fqdn) ?? (status.peers ?? []).find((row) => row.status === 'connected') ?? null;
  return {
    status,
    peer,
    seconds: pollSeconds(status),
    affinity: status.settings?.poolLocalAffinity ?? DEFAULT_LOCAL_AFFINITY,
    weight: status.settings?.poolPressureWeight ?? DEFAULT_PRESSURE_WEIGHT,
  };
}

/**
 * Expected candidate count for a model: one per healthy LOCAL backend holding it, plus at most one
 * per peer (hub-pool-proxy.service.ts:573-593, :620-641). The doc's literal `ATT 1/2` is not a
 * constant — a node running two engines that both list the model legitimately logs 1/3.
 */
function expectedCandidates(status, peer, model) {
  const local = (status.localNode?.backends ?? []).filter(
    (backend) => backend.healthy === true && (backend.modelsLoaded ?? []).includes(model),
  ).length;
  const fromPeer = peer && peer.lastCapabilities?.acceptingWork !== false && backendsHold(peer.lastCapabilities?.backends, model) ? 1 : 0;
  return { local, peer: fromPeer, total: local + fromPeer };
}

/** The settings gate every 3.x/4.x expectation depends on. */
function tuningGate(routing) {
  if (routing.affinity !== DEFAULT_LOCAL_AFFINITY || routing.weight !== DEFAULT_PRESSURE_WEIGHT) {
    return `poolLocalAffinity=${routing.affinity} poolPressureWeight=${routing.weight} — every expected outcome in 3.x/4.x is arithmetic on these two, so the doc's predictions are wrong at these values, not the code`;
  }
  return null;
}

/** Poll core's status until `localNode.inFlightRequests` reads the depth this step needs. */
async function waitForDepth(ctx, depth, budgetMs = 6000) {
  return until(
    async () => {
      const res = await getStatus(ctx.core);
      if (!res.ok) return null;
      return res.json.localNode?.inFlightRequests === depth ? res.json : null;
    },
    { budgetMs, intervalMs: 250 },
  );
}

/** The newest outbound routing-log row for a model, recorded at or after `sinceMs`. */
async function newestOutbound(node, model, sinceMs, limit = 5) {
  const log = await getRoutingLog(node, limit);
  if (!log.ok) return { error: httpSummary(log) };
  const matches = entriesSince(log.json, sinceMs, (entry) => entry.direction === 'outbound' && (model === null || entry.model === model));
  return { entry: matches[0] ?? null, all: matches, log: log.json };
}

const SECTION_3 = [
  {
    id: '3.0.1',
    title: 'Preflight: core’s settings, peer row and local inventory',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const routing = await routingContext(ctx);
      if (routing.error) return fail(routing.error);
      if (routing.status.enabled !== true)
        return blocked(`pooling is off on core (disabledBy '${routing.status.disabledBy}') — every routing step below is vacuous`);
      if (routing.status.directions?.outbound?.enabled !== true)
        return blocked('outbound is switched off on core — nothing will be routed to a peer');
      if ((routing.status.peerCounts?.connected ?? 0) < 1) return blocked('core has no connected peer — section 2 has not completed');
      if (!routing.peer) return blocked('no usable peer row on core');
      ctx.state.peerIdOnCore = routing.peer.id;
      ctx.state.pollSeconds = routing.seconds;
      const tuning = tuningGate(routing);
      if (tuning) return blocked(tuning);
      return pass(
        `affinity ${routing.affinity}, pressureWeight ${routing.weight}, peer ${String(routing.peer.id).slice(0, 8)} (${routing.peer.nodeFqdn}), local inFlight ${routing.status.localNode?.inFlightRequests}`,
      );
    },
  },
  {
    id: '3.0.2',
    title: 'Preflight: peer snapshot freshness (gates 3.2, 3.3, 4.1, 4.2)',
    on: 'core',
    wire: `GET ${POOL}/status (peers[].lastSeenAt, lastCapabilities)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const routing = await routingContext(ctx);
      if (routing.error) return fail(routing.error);
      if (!routing.peer) return blocked('no peer row on core');
      // There is no "poll now" route, so the only remedy for a stale snapshot is one poll interval.
      const settled = await until(
        async () => {
          const again = await routingContext(ctx);
          if (again.error || !again.peer) return null;
          const fresh = snapshotFresh(again.peer, again.seconds);
          const reported = again.peer.lastCapabilities?.inFlightRequests;
          return fresh && again.peer.lastCapabilities && typeof reported === 'number' && again.peer.lastCapabilities.acceptingWork !== false
            ? again
            : null;
        },
        { budgetMs: (routing.seconds + 5) * 1000, intervalMs: 3000 },
      );
      if (settled) {
        ctx.state.snapshotFresh = true;
        return pass(
          `snapshot fresh (lastSeenAt ${settled.peer.lastSeenAt}), acceptingWork, peer self-reports inFlight ${settled.peer.lastCapabilities.inFlightRequests}`,
        );
      }
      ctx.state.snapshotFresh = false;
      const age = routing.peer.lastSeenAt ? Math.round((Date.now() - Date.parse(routing.peer.lastSeenAt)) / 1000) : null;
      return blocked(
        `peer snapshot stale or carries no inFlightRequests (age ${age === null ? 'never seen' : `${age}s`}, trusted for ${routing.seconds * FRESHNESS_POLLS}s) — the ranker scores it at UNKNOWN_PEER_LOAD 1, which turns 4.1's decisive result into a tie local wins`,
      );
    },
  },
  {
    id: '3.0.3',
    title: 'Make the two model inventories differ (<model-beta> on beta only)',
    on: 'both',
    wire: 'POST /api/inference/models/pull exists; there is NO delete route — removing a model needs a shell',
    tier: 'readonly',
    manualAction:
      'On core: `ollama rm <model-beta>` (or pick a different <model-beta> via POOL_QA_MODEL_BETA). Sections 3 and 4 are only meaningful when exactly one node has it.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const gapped = modelGate(ctx.state);
      if (gapped) return blocked(gapped);
      const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
      if (!core.ok || !beta.ok) return fail(`core ${httpSummary(core)} / beta ${httpSummary(beta)}`);
      const coreModels = modelsOf(core.json.localNode?.backends);
      const betaModels = modelsOf(beta.json.localNode?.backends);
      const problems = [];
      if (!coreModels.has(ctx.state.models.both)) problems.push(`core lacks <model-both> "${ctx.state.models.both}"`);
      if (!betaModels.has(ctx.state.models.both)) problems.push(`beta lacks <model-both> "${ctx.state.models.both}"`);
      if (!betaModels.has(ctx.state.models.beta)) problems.push(`beta lacks <model-beta> "${ctx.state.models.beta}"`);
      if (coreModels.has(ctx.state.models.beta)) {
        return fail(
          `<model-beta> "${ctx.state.models.beta}" is on core too — inventories identical, so a correct routing decision is indistinguishable from a lucky one`,
        );
      }
      return problems.length ? fail(problems.join('; ')) : pass('inventories differ as required: <model-both> on both, <model-beta> on beta only');
    },
  },
  {
    id: '3.1.1',
    title: '3.1 precondition: beta is the only node advertising <model-beta>',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const routing = await routingContext(ctx);
      if (routing.error) return fail(routing.error);
      if (!routing.peer) return blocked('no peer row on core');
      const counts = expectedCandidates(routing.status, routing.peer, ctx.state.models.beta);
      if (counts.local > 0) return fail(`core advertises <model-beta> on ${counts.local} healthy backend(s) — 3.0.3 was not done`);
      if (counts.peer !== 1) {
        return blocked(
          `peer capabilities do not list <model-beta> (acceptingWork=${routing.peer.lastCapabilities?.acceptingWork ?? 'absent'}); wait one poll (${routing.seconds}s) and re-read before calling it a failure`,
        );
      }
      ctx.state.expected.beta = counts.total;
      return pass('predicted candidates=1 (0 local, 1 peer) for <model-beta>');
    },
  },
  {
    id: '3.1.2',
    title: '3.1 Request a model only beta has, from core',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-beta>, which only beta can serve. Spends GPU time on beta.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      // Warm the model first: with stream:false no headers arrive until generation finishes, and the
      // proxy aborts a candidate after CONNECT_TIMEOUT_MS = 15s without headers, which looks like a
      // failover rather than a cold load.
      await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      ctx.state.marks['3.1'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (res.status === 200)
        return looksOpenAi(res.json) ? pass('HTTP 200 with an OpenAI-shaped completion') : fail('HTTP 200 but the body carries no choices[]');
      if (res.status === 502) {
        const kind = classify502(res, ctx.state.models.beta);
        return fail(
          kind === 'no-candidates' ? '502 no candidates — beta’s cached capabilities do not list the model (see 3.1.1)' : `502 ${errorText(res)}`,
        );
      }
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration, not a routing result`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '3.1.3',
    title: '3.1 Core’s routing log names the peer',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['3.1'];
      if (!since) return blocked('3.1.2 did not run, so there is no request to find in the log');
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound routing-log entry for <model-beta> since the request was sent');
      const entry = found.entry;
      const problems = [];
      if (entry.node === LOCAL_NODE) problems.push('node=local — core has the model after all');
      if (entry.peerId !== ctx.state.peerIdOnCore) problems.push(`peerId ${entry.peerId} != the peer row id ${ctx.state.peerIdOnCore}`);
      if (entry.path !== '/v1/chat/completions') problems.push(`path='${entry.path}'`);
      if (entry.candidates !== 1) problems.push(`candidates=${entry.candidates}, expected 1`);
      if (entry.attempt !== 1) problems.push(`attempt=${entry.attempt}`);
      if ((entry.failedOverFrom ?? []).length !== 0) problems.push(`failedOverFrom=[${entry.failedOverFrom.join(', ')}]`);
      if (entry.outcome !== 'served' || !entry.ok) problems.push(`outcome=${entry.outcome} status=${entry.status}`);
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
  {
    id: '3.1.4',
    title: '3.1 Beta records the matching inbound row',
    on: 'beta',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const since = ctx.state.marks['3.1'];
      if (!since) return blocked('3.1.2 did not run');
      const log = await getRoutingLog(ctx.beta, 5);
      if (!log.ok) return fail(httpSummary(log));
      // Never match on model: recordInbound hardcodes `model: null` because the peer's body is
      // deliberately never parsed (hub-pool-proxy.service.ts:501-527).
      const inbound = entriesSince(log.json, since, (entry) => entry.direction === 'inbound' && entry.path === '/v1/chat/completions');
      if (inbound.length === 0)
        return fail('no inbound row on beta in the window — beta did not serve it, and core’s outbound row is then contradictory');
      const entry = inbound[0];
      const problems = [];
      if (ctx.core.fqdn && entry.node !== ctx.core.fqdn) problems.push(`node='${entry.node}', expected core’s ${ctx.core.fqdn}`);
      if (entry.candidates !== 1 || entry.attempt !== 1) problems.push(`att ${entry.attempt}/${entry.candidates}, expected 1/1`);
      if (entry.outcome !== 'served' || !entry.ok)
        problems.push(`outcome=${entry.outcome} status=${entry.status} (503 = beta refused the forward, 403 = not connected)`);
      return problems.length
        ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`)
        : pass(`${describeEntry(entry)} (model is null by construction on inbound rows)`);
    },
  },
  {
    id: '3.2.1',
    title: '3.2 precondition: both nodes advertise <model-both>, both idle',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const routing = await routingContext(ctx);
      if (routing.error) return fail(routing.error);
      if (!routing.peer) return blocked('no peer row on core');
      if ((routing.status.localNode?.inFlightRequests ?? 0) !== 0)
        return blocked(`core is not idle (inFlight ${routing.status.localNode.inFlightRequests})`);
      const counts = expectedCandidates(routing.status, routing.peer, ctx.state.models.both);
      if (counts.local === 0) {
        return blocked(
          'core has no healthy backend holding <model-both>, so it contributes no local candidate and the affinity handicap has nothing to apply to',
        );
      }
      if (counts.peer !== 1)
        return blocked('the peer contributes no candidate for <model-both> (stale snapshot, acceptingWork false, or the model is missing there)');
      ctx.state.expected.both = counts.total;
      return pass(`expected candidates E=${counts.total} (${counts.local} local + 1 peer); both idle`);
    },
  },
  {
    id: '3.2.2',
    title: '3.2 Request a shared model with both nodes idle',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-both> with both nodes idle. Spends GPU time.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      ctx.state.marks['3.2'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (res.status === 200) return looksOpenAi(res.json) ? pass('HTTP 200 with an OpenAI-shaped completion') : fail('HTTP 200 but no choices[]');
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '3.2.3',
    title: '3.2 The idle local node wins on rank, with the peer genuinely in the running',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['3.2'];
      if (!since) return blocked('3.2.2 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound entry for <model-both> since the request');
      const entry = found.entry;
      const expected = ctx.state.expected.both;
      const problems = [];
      if (entry.node !== LOCAL_NODE)
        problems.push(`node='${entry.node}' on an idle core — the affinity handicap is not being applied (local 0 vs peer 0+1)`);
      if (entry.peerId !== null) problems.push(`peerId=${entry.peerId}, expected null for a local decision`);
      if (entry.candidates === 1)
        problems.push('candidates=1 — the peer was never a candidate (stale snapshot, acceptingWork false, peer disabled, or outbound off)');
      else if (expected && entry.candidates !== expected) problems.push(`candidates=${entry.candidates}, expected E=${expected}`);
      if (entry.attempt !== 1 || entry.outcome !== 'served' || !entry.ok)
        problems.push(`att ${entry.attempt} outcome=${entry.outcome} status=${entry.status}`);
      return problems.length
        ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`)
        : pass(`${describeEntry(entry)} — local 0 beat peer 0+affinity 1, with the peer ranked and losing`);
    },
  },
  {
    id: '3.3.1',
    title: '3.3 precondition: read the affinity setting the step is arithmetic over',
    on: 'core',
    wire: `GET ${POOL}/settings`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getSettings(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const { poolLocalAffinity: affinity, poolPressureWeight: weight } = res.json ?? {};
      if (affinity !== DEFAULT_LOCAL_AFFINITY || (weight ?? DEFAULT_PRESSURE_WEIGHT) !== DEFAULT_PRESSURE_WEIGHT) {
        return blocked(
          `poolLocalAffinity=${affinity} poolPressureWeight=${weight} — at these values local wins while localInFlight <= peerLoad + ${affinity}; the doc's prediction assumes 1 and 0`,
        );
      }
      return pass(`poolLocalAffinity=${affinity}, poolPressureWeight=${weight ?? DEFAULT_PRESSURE_WEIGHT}`);
    },
  },
  {
    id: '3.3.2',
    title: '3.3 Hold one streamed request open on core',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (stream:true, held open)`,
    tier: 'execute',
    would: 'open one streaming completion on core and hold it, so core’s in-flight depth reads 1. Spends GPU time; always released in teardown.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['3.3-hold'] = Date.now();
      const held = await openHeldStream(ctx, ctx.core, ctx.state.models.both, 'write 400 words about tides', '3.3 hold');
      if (!held.ok) return fail(`stream headers ${held.status || 'never arrived'}${held.error ? `: ${held.error}` : ''}`);
      if (held.finished) return fail('the stream ended immediately — a too-short generation makes 3.3.5 vacuous');
      return pass('streaming response committed with 200 headers and held open under an AbortController');
    },
  },
  {
    id: '3.3.3',
    title: '3.3 Confirm core’s queue depth really is 1',
    on: 'core',
    wire: `GET ${POOL}/status (localNode.inFlightRequests)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const status = await waitForDepth(ctx, 1, 5000);
      if (!status) {
        const res = await getStatus(ctx.core);
        return blocked(
          `localNode.inFlightRequests=${res.json?.localNode?.inFlightRequests ?? '?'}, expected 1 — the held stream finished early or was routed to the peer`,
        );
      }
      const peer = findPeerRow(status.peers, ctx.beta.fqdn) ?? status.peers?.[0];
      if ((peer?.inFlightRequests ?? 0) !== 0) return fail(`the held stream leaked to the peer (peers[].inFlightRequests=${peer.inFlightRequests})`);
      return pass('localNode.inFlightRequests=1, nothing forwarded to the peer');
    },
  },
  {
    id: '3.3.4',
    title: '3.3 Send a second request at depth 1',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST a second, non-streaming completion while the held stream keeps core at depth 1',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['3.3'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (res.status === 200) return looksOpenAi(res.json) ? pass('HTTP 200 at depth 1') : fail('HTTP 200 but no choices[]');
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '3.3.5',
    title: '3.3 One queued request is exactly the head start affinity=1 grants',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['3.3'];
      if (!since) return blocked('3.3.4 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound entry since 3.3.4');
      const entry = found.entry;
      const problems = [];
      if (entry.node !== LOCAL_NODE)
        problems.push(
          `node='${entry.node}' at depth 1 — the handicap is off by one; work should stay local until a peer is MORE than one request emptier`,
        );
      if (entry.peerId !== null) problems.push(`peerId=${entry.peerId}`);
      if (entry.candidates < 2) problems.push(`candidates=${entry.candidates} — the peer was not ranked`);
      if (entry.attempt !== 1 || entry.outcome !== 'served' || !entry.ok)
        problems.push(`att ${entry.attempt} outcome=${entry.outcome} status=${entry.status}`);
      const caveat = ctx.state.snapshotFresh
        ? ''
        : ' (NOTE: the peer snapshot was stale, so this tie also resolves local for the wrong reason — weaker evidence than 4.1)';
      return problems.length
        ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`)
        : pass(`${describeEntry(entry)} — local 1 tied peer 0+1 and won on LOCAL_TIER_RANK${caveat}`);
    },
  },
  {
    id: '3.3.6',
    title: '3.3 Release the held stream and confirm the counter unwinds',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'execute',
    would: 'abort the held stream from 3.3.2 and poll until core’s in-flight counter returns to 0',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const released = await releaseHeldStreams(ctx);
      const status = await waitForDepth(ctx, 0, 15_000);
      if (!status) {
        const res = await getStatus(ctx.core);
        return fail(
          `localNode.inFlightRequests stayed at ${res.json?.localNode?.inFlightRequests} after the stream was gone — a leaked acquire; 4.1's arithmetic would be off by the leak`,
        );
      }
      return pass(`released ${released} held stream(s); inFlightRequests back to 0`);
    },
  },
];

const SECTION_4 = [
  {
    id: '4.1.1',
    title: '4.1 precondition: both nodes idle, snapshot fresh, affinity 1',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta), modelGate(ctx.state));
      if (stop) return stop;
      const routing = await routingContext(ctx);
      if (routing.error) return fail(routing.error);
      if (!routing.peer) return blocked('no peer row on core');
      const tuning = tuningGate(routing);
      if (tuning) return blocked(tuning);
      const beta = await getStatus(ctx.beta);
      if (!beta.ok) return fail(`beta ${httpSummary(beta)}`);
      const problems = [];
      if ((routing.status.localNode?.inFlightRequests ?? 0) !== 0) problems.push(`core inFlight ${routing.status.localNode.inFlightRequests}`);
      if ((routing.peer.inFlightRequests ?? 0) !== 0) problems.push(`core->peer inFlight ${routing.peer.inFlightRequests}`);
      if ((beta.json.localNode?.inFlightRequests ?? 0) !== 0) problems.push(`beta inFlight ${beta.json.localNode.inFlightRequests}`);
      if (problems.length) return blocked(`not idle: ${problems.join(', ')}`);
      if (!snapshotFresh(routing.peer, routing.seconds) || routing.peer.lastCapabilities?.inFlightRequests !== 0) {
        return blocked(
          'peer snapshot stale or not self-reporting 0 — the peer would score UNKNOWN_PEER_LOAD 1 + affinity 1 = 2, tying core’s 2 and losing to LOCAL_TIER_RANK, so this step would report the headline defect while the code behaves correctly',
        );
      }
      const counts = expectedCandidates(routing.status, routing.peer, ctx.state.models.both);
      ctx.state.expected.both = counts.total;
      return pass(`both idle, snapshot fresh (peer self-reports 0), E=${counts.total}`);
    },
  },
  {
    id: '4.1.2',
    title: '4.1 Hold two streamed requests open on core',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (stream:true) x2`,
    tier: 'execute',
    would: 'open two concurrent streaming completions on core and hold both, driving core to depth 2. Spends GPU time; always released in teardown.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['4.1-hold'] = Date.now();
      const held = await Promise.all([
        openHeldStream(ctx, ctx.core, ctx.state.models.both, 'write 800 words about tides', '4.1 hold A'),
        openHeldStream(ctx, ctx.core, ctx.state.models.both, 'write 800 words about tides', '4.1 hold B'),
      ]);
      const bad = held.filter((stream) => !stream.ok);
      if (bad.length) return fail(`${bad.length} of 2 streams did not commit 200 headers (${bad.map((s) => s.error ?? s.status).join(', ')})`);
      // Both must land LOCALLY for the setup to be valid — verify from the log rather than assuming.
      await sleep(1500);
      const found = await newestOutbound(ctx.core, ctx.state.models.both, ctx.state.marks['4.1-hold'], 10);
      const local = (found.all ?? []).filter((entry) => entry.node === LOCAL_NODE).length;
      if (local < 2) return fail(`only ${local} of the two held streams landed locally — core’s depth never reaches 2 and 4.1.5 tests nothing`);
      return pass('two streams committed and held, both logged node=local');
    },
  },
  {
    id: '4.1.3',
    title: '4.1 Confirm core really reads In flight 2 before the third request',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const status = await waitForDepth(ctx, 2, 6000);
      if (!status) {
        const res = await getStatus(ctx.core);
        return blocked(`localNode.inFlightRequests=${res.json?.localNode?.inFlightRequests ?? '?'}, expected 2 — do not send 4.1.4; re-run 4.1.2`);
      }
      const peer = findPeerRow(status.peers, ctx.beta.fqdn) ?? status.peers?.[0];
      ctx.state.depthTwoEvidence = {
        peerForwarded: peer?.inFlightRequests ?? null,
        peerSelfReport: peer?.lastCapabilities?.inFlightRequests ?? null,
      };
      if ((peer?.inFlightRequests ?? 0) !== 0) return fail(`the held streams leaked to the peer (peers[].inFlightRequests=${peer.inFlightRequests})`);
      return pass(`core inFlight 2; peer forwarded 0, peer self-reports ${ctx.state.depthTwoEvidence.peerSelfReport}`);
    },
  },
  {
    id: '4.1.4',
    title: '4.1 Send the third request at depth 2',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST a third, non-streaming completion while core sits at depth 2',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['4.1'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (res.status === 200) return looksOpenAi(res.json) ? pass('HTTP 200 at depth 2') : fail('HTTP 200 but no choices[]');
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '4.1.5',
    title: '4.1 The saturated node hands the third request to the idle peer',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['4.1'];
      if (!since) return blocked('4.1.4 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound entry since 4.1.4');
      const entry = found.entry;
      if (entry.node === LOCAL_NODE) {
        // Only the headline defect when the two preconditions actually held.
        if (!ctx.state.snapshotFresh) return blocked('node=local, but the peer snapshot was stale — INCONCLUSIVE, not the headline defect');
        return fail(
          'node=local at depth 2 with a fresh peer snapshot reading 0 — a saturated node queueing behind itself while a paired peer sits idle',
        );
      }
      const problems = [];
      if (entry.peerId !== ctx.state.peerIdOnCore) problems.push(`peerId ${entry.peerId} != peer row ${ctx.state.peerIdOnCore}`);
      if (entry.attempt !== 1)
        problems.push(
          `attempt=${entry.attempt} — the peer was ranked first and rejected the forward; inspect beta’s inbound row (503 = inbound refused, 403 = not connected)`,
        );
      if ((entry.failedOverFrom ?? []).length) problems.push(`failedOverFrom=[${entry.failedOverFrom.join(', ')}]`);
      if (entry.candidates < 2) problems.push(`candidates=${entry.candidates}`);
      if (entry.outcome !== 'served' || !entry.ok) problems.push(`outcome=${entry.outcome} status=${entry.status}`);
      return problems.length
        ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`)
        : pass(`${describeEntry(entry)} — local 2 vs peer 0+1, the peer wins outright with no tie-break`);
    },
  },
  {
    id: '4.1.6',
    title: '4.1 Beta carries the matching inbound row',
    on: 'beta',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const since = ctx.state.marks['4.1'];
      if (!since) return blocked('4.1.4 did not run');
      const log = await getRoutingLog(ctx.beta, 5);
      if (!log.ok) return fail(httpSummary(log));
      const inbound = entriesSince(log.json, since, (entry) => entry.direction === 'inbound' && entry.path === '/v1/chat/completions');
      if (inbound.length === 0) return fail('no inbound row on beta despite core’s log naming it — a contradiction; dump both logs');
      const entry = inbound[0];
      const problems = [];
      if (ctx.core.fqdn && entry.node !== ctx.core.fqdn) problems.push(`node='${entry.node}'`);
      if (entry.outcome !== 'served' || !entry.ok) problems.push(`outcome=${entry.outcome} status=${entry.status} — beta refused the forward`);
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
  {
    id: '4.1.7',
    title: '4.1 Release the two held streams and return both nodes to idle',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'execute',
    would: 'abort both held streams and poll until core and beta both read 0 in flight',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const released = await releaseHeldStreams(ctx);
      const settled = await until(
        async () => {
          const [core, beta] = await Promise.all([getStatus(ctx.core), getStatus(ctx.beta)]);
          if (!core.ok || !beta.ok) return null;
          const peer = findPeerRow(core.json.peers, ctx.beta.fqdn) ?? core.json.peers?.[0];
          const idle =
            core.json.localNode?.inFlightRequests === 0 && (peer?.inFlightRequests ?? 0) === 0 && beta.json.localNode?.inFlightRequests === 0;
          return idle ? { core: core.json, beta: beta.json } : null;
        },
        { budgetMs: 30_000, intervalMs: 1000 },
      );
      return settled
        ? pass(`released ${released} stream(s); both nodes back to 0 in flight`)
        : fail('a counter did not unwind — leaked acquire; 4.2 must not run');
    },
  },
  {
    id: '4.2.1',
    title: '4.2 Burst six concurrent streamed requests from core',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (stream:true) x6`,
    tier: 'execute',
    would: 'dispatch six overlapping streaming completions from core and read each to completion. Spends real GPU time on both nodes.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['4.2'] = Date.now();
      const opened = await Promise.all(
        Array.from({ length: 6 }, (_unused, index) =>
          openHeldStream(ctx, ctx.core, ctx.state.models.both, 'write 400 words about tides', `4.2 burst ${index + 1}`),
        ),
      );
      // Prove the requests genuinely overlap: a serialized harness produces an all-local run that
      // looks exactly like the failure mode.
      const overlap = await until(
        async () => {
          const res = await getStatus(ctx.core);
          if (!res.ok) return null;
          const peer = findPeerRow(res.json.peers, ctx.beta.fqdn) ?? res.json.peers?.[0];
          const depth = (res.json.localNode?.inFlightRequests ?? 0) + (peer?.inFlightRequests ?? 0);
          return depth >= 2 ? depth : null;
        },
        { budgetMs: 20_000, intervalMs: 500 },
      );
      const bad = opened.filter((stream) => !stream.ok);
      // The doc's `wait`: read each to completion before scoring the split. Bounded, because
      // `openHeldStream` clears its header timer once headers arrive and the body pump then has no
      // deadline of its own: one wedged generation, or a socket that dies without a FIN, would
      // otherwise hang the runner here forever with no output and no teardown.
      const pumps = opened.map((stream) => stream.pump).filter(Boolean);
      const drained = await within(Promise.allSettled(pumps), INFER_TIMEOUT_MS);
      if (!drained) {
        for (const stream of opened) {
          if (stream.finished) continue;
          try {
            stream.controller.abort(new Error('burst drain exceeded the inference budget'));
          } catch {
            stream.error = stream.error ?? 'abort failed';
          }
        }
        await within(Promise.allSettled(pumps), STREAM_UNWIND_MS);
      }
      ctx.state.heldStreams = ctx.state.heldStreams.filter((stream) => !opened.includes(stream));
      if (bad.length) return fail(`${bad.length} of 6 did not commit 200 headers (${bad.map((s) => s.error ?? s.status).join(', ')})`);
      if (!drained) {
        const stuck = opened.filter((stream) => !stream.finished).length;
        return blocked(
          `${stuck} of 6 streams were still generating after ${Math.round(INFER_TIMEOUT_MS / 1000)}s and were aborted — the split cannot be scored from a truncated burst (raise POOL_QA_INFER_TIMEOUT_MS, or check whether an engine is wedged)`,
        );
      }
      if (!overlap)
        return blocked(
          'never observed combined depth >= 2 — the requests serialized instead of overlapping, which is a harness result, not a product one',
        );
      return pass(`six streams dispatched concurrently (peak observed combined depth ${overlap}) and read to completion`);
    },
  },
  {
    id: '4.2.2',
    title: '4.2 The burst splits across both nodes',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=12`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['4.2'];
      if (!since) return blocked('4.2.1 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since, 12);
      if (found.error) return fail(found.error);
      const rows = found.all ?? [];
      if (rows.length < 6) {
        // The log is a 200-entry in-memory ring a restart empties: confirm the count before scoring.
        const wider = await newestOutbound(ctx.core, ctx.state.models.both, since, 200);
        if ((wider.all ?? []).length < 6) return blocked(`only ${(wider.all ?? []).length} of 6 burst rows are in the log — do not judge the split`);
        rows.splice(0, rows.length, ...wider.all);
      }
      const onPeer = rows.filter((entry) => entry.peerId === ctx.state.peerIdOnCore || (entry.node !== LOCAL_NODE && entry.node !== null)).length;
      const onLocal = rows.filter((entry) => entry.node === LOCAL_NODE).length;
      const rendered = `${onLocal} local / ${onPeer} peer of ${rows.length}`;
      if (onPeer === 0) return fail(`${rendered} — no handoff under load`);
      if (onLocal === 0) return fail(`${rendered} — the affinity handicap is not applied`);
      if (onPeer < 2) return fail(`${rendered} — the plan asks for at least 2 on the peer and at least 1 local`);
      return pass(`${rendered} — the burst split across both nodes`);
    },
  },
];
// ─────────────────────────────────────────────────────────────────────────────
// Steps — sections 5 and 6: failover and recovery
//
// Five of these need a shell, and all five for the same reason: nothing in the HTTP API can start
// or stop an inference engine. Backend supervision is observe-and-report by design ("the Hub never
// restarts an inference backend", hub-pool.types.ts:116). PATCH /settings {poolInboundEnabled:false}
// and POST /peers/:id/disable produce a HEALTHY node that politely refuses — section 7's subject and
// a different code path — so there is no honest substitute.
// ─────────────────────────────────────────────────────────────────────────────

/** Does this node currently serve the model from a healthy backend of its own? */
async function servesLocally(node, model) {
  const res = await getStatus(node);
  if (!res.ok) return { error: httpSummary(res) };
  return { serves: backendsHold(res.json.localNode?.backends, model), status: res.json };
}

/** Is the peer row on `node` connected, fresh, and advertising the model? */
async function peerServes(node, peerFqdn, model) {
  const res = await getStatus(node);
  if (!res.ok) return { error: httpSummary(res) };
  const peer = findPeerRow(res.json.peers, peerFqdn) ?? res.json.peers?.[0] ?? null;
  return {
    peer,
    status: res.json,
    serves: Boolean(peer) && peer.status === 'connected' && peer.enabled !== false && backendsHold(peer.lastCapabilities?.backends, model),
  };
}

const SECTION_5 = [
  {
    id: '5.1.1',
    title: 'Preflight: core sees beta connected and both nodes hold <model-both>',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const res = await getStatus(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      const problems = [];
      if (status.enabled !== true) problems.push(`enabled=false (disabledBy '${status.disabledBy}')`);
      if (status.directions?.outbound?.enabled !== true) problems.push('outbound off');
      if (!backendsHold(status.localNode?.backends, ctx.state.models.both)) problems.push('core has no healthy backend holding <model-both>');
      const peer = findPeerRow(status.peers, ctx.beta.fqdn) ?? status.peers?.[0];
      if (peer) {
        if (peer.status !== 'connected') problems.push(`peer status='${peer.status}'`);
        if (peer.enabled === false) problems.push('peer is disabled');
        if (!backendsHold(peer.lastCapabilities?.backends, ctx.state.models.both)) problems.push('peer capabilities do not hold <model-both>');
      } else problems.push('no peer row for beta');
      if (problems.length) return blocked(`section 5 precondition unmet: ${problems.join('; ')}`);
      ctx.state.failoverBaseline = { peerId: peer.id, consecutiveFailures: peer.consecutiveFailures, lastSeenAt: peer.lastSeenAt };
      ctx.state.pollSeconds = pollSeconds(status);
      return pass(`peer ${String(peer.id).slice(0, 8)} connected, both nodes hold <model-both>, failures ${peer.consecutiveFailures}`);
    },
  },
  {
    id: '5.1.2',
    title: 'Snapshot the routing-log watermark before the manual engine kill',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=200`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getRoutingLog(ctx.core, 200);
      if (!res.ok) return fail(httpSummary(res));
      // Entries are newest first; entries[0].at is the watermark every later "since" check uses.
      ctx.state.watermark.core = {
        recorded: res.json.summary?.recorded ?? 0,
        failovers: res.json.summary?.failovers ?? 0,
        at: res.json.entries?.[0]?.at ?? null,
      };
      return pass(
        `recorded=${ctx.state.watermark.core.recorded} failovers=${ctx.state.watermark.core.failovers} newest=${ctx.state.watermark.core.at ?? 'none'}`,
      );
    },
  },
  {
    id: '5.1.3',
    title: 'MANUAL: stop beta’s inference engine container',
    on: 'beta',
    wire: 'no HTTP route starts or stops an inference backend — supervision is observe-and-report',
    tier: 'readonly',
    manualAction: 'beta$ docker stop <beta ollama container>',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), modelGate(ctx.state));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      if (!ctx.opts.interactive) {
        return manual('run `docker stop` on beta’s engine, then re-run --only 5 — the runner gates 5.1.4 on beta no longer serving <model-both>');
      }
      await promptOperator(ctx, 'Stop beta’s inference engine container now, then press Enter.');
      const down = await until(
        async () => {
          if (ctx.beta.token) {
            const own = await servesLocally(ctx.beta, ctx.state.models.both);
            return own.error ? null : !own.serves || own.status.localNode?.capabilitiesError;
          }
          const seen = await peerServes(ctx.core, ctx.beta.fqdn, ctx.state.models.both);
          return seen.error ? null : !seen.serves;
        },
        { budgetMs: seconds * 2 * 1000 + PROBE_TIMEOUT_MS * 2, intervalMs: 3000 },
      );
      return down
        ? manual('engine confirmed down on beta — 5.1.4 may proceed')
        : blocked('beta still serves <model-both> after 2 poll intervals — wrong container, or another backend still serves it');
    },
  },
  {
    id: '5.1.4',
    title: 'A pooled completion survives the peer’s dead engine',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-both> while beta’s engine is down — it must be served locally, not fail',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['5.1'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (res.status === 200)
        return looksOpenAi(res.json)
          ? pass('HTTP 200 — a dead engine on one node did not fail a request the other could serve')
          : fail('HTTP 200 but no choices[]');
      if (res.status === 502) {
        const kind = classify502(res, ctx.state.models.both);
        return kind === 'no-candidates'
          ? fail('502 no-candidates — core’s own engine is also not serving <model-both>, so 5.1.1 was wrong')
          : fail('502 all-unreachable — candidates existed, every one was tried and failed');
      }
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration, not a step failure`);
      if (res.status === 400) return blocked(`400 ${errorText(res)} — malformed body from the runner`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '5.1.5',
    title: 'The routing log records ONE entry for the whole failover chain',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['5.1'];
      if (!since) return blocked('5.1.4 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      const rows = (found.all ?? []).filter((entry) => entry.path === '/v1/chat/completions');
      if (rows.length === 0) return fail('no outbound entry since 5.1.4');
      if (rows.length > 1) return fail(`${rows.length} entries for one request — the chain was logged per attempt instead of once`);
      const entry = rows[0];
      if (entry.node !== LOCAL_NODE) return fail(`node='${entry.node}', expected local`);
      if (entry.outcome !== 'served') return fail(`outcome=${entry.outcome}`);
      // Three shapes are legal. The doc allows only two, and would mark correct behaviour FAIL:
      // once the health poll has refreshed beta's snapshot, peerCandidates skips it and ATT 1/1 is
      // the only shape available.
      const shape = `att ${entry.attempt}/${entry.candidates} failedOverFrom=[${(entry.failedOverFrom ?? []).join(', ')}]`;
      const legal =
        (entry.attempt === 1 && entry.candidates === 2 && (entry.failedOverFrom ?? []).length === 0) ||
        (entry.attempt === 2 && entry.candidates === 2 && (entry.failedOverFrom ?? []).length === 1) ||
        (entry.attempt === 1 && entry.candidates === 1 && (entry.failedOverFrom ?? []).length === 0);
      return legal ? pass(`one entry, served locally, ${shape}`) : fail(`one entry, served locally, but an unexpected shape: ${shape}`);
    },
  },
  {
    id: '5.2.1',
    title: 'MANUAL: restart beta’s engine, then stop core’s engine',
    on: 'both',
    wire: 'two container actions on two boxes — no API surface controls an inference backend',
    tier: 'readonly',
    manualAction: 'beta$ docker start <beta ollama container>  ·  core$ docker stop <core ollama container>',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      if (!ctx.opts.interactive) return manual('restart beta’s engine and stop core’s, then re-run --only 5');
      await promptOperator(ctx, 'Start beta’s engine and stop core’s engine now, then press Enter.');
      // Gate (a): beta is back. Costs up to one poll — its candidacy comes from the CACHED snapshot.
      const betaBack = await until(
        async () => {
          const seen = await peerServes(ctx.core, ctx.beta.fqdn, ctx.state.models.both);
          return !seen.error && seen.serves && seen.peer.consecutiveFailures === 0 ? seen : null;
        },
        { budgetMs: (seconds * FRESHNESS_POLLS + 10) * 1000, intervalMs: 3000 },
      );
      if (!betaBack) return blocked(`beta’s snapshot did not return to healthy within ${seconds * FRESHNESS_POLLS}s`);
      // Gate (b): core is down. Immediate — localCandidates calls healthCheck() live per request.
      const coreDown = await servesLocally(ctx.core, ctx.state.models.both);
      if (coreDown.error) return fail(coreDown.error);
      if (coreDown.serves) return blocked('core still serves <model-both> locally — the wrong container was stopped');
      return manual('beta back and core down — 5.2.2 may proceed');
    },
  },
  {
    id: '5.2.2',
    title: 'With core’s engine dead, the request must be served by the peer',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-both> while core’s own engine is down — beta must serve it',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['5.2'] = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (res.status === 200)
        return looksOpenAi(res.json) ? pass('HTTP 200 served by the pool with core’s engine down') : fail('HTTP 200 but no choices[]');
      if (res.status === 502) {
        const kind = classify502(res, ctx.state.models.both);
        return kind === 'no-candidates'
          ? blocked(
              '502 no-candidates — no candidate was produced at all, so beta’s snapshot was stale or unhealthy: a setup miss, not a routing bug',
            )
          : fail('502 all-unreachable — beta WAS ranked and the forward to it failed');
      }
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      return fail(httpSummary(res));
    },
  },
  {
    id: '5.2.3',
    title: 'Core’s routing log names beta as the serving node',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = ctx.state.marks['5.2'];
      if (!since) return blocked('5.2.2 did not run');
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound entry since 5.2.2');
      const entry = found.entry;
      const problems = [];
      if (entry.node === LOCAL_NODE) problems.push('node=local — core’s engine is not actually down');
      if (ctx.beta.fqdn && entry.node !== ctx.beta.fqdn) problems.push(`node='${entry.node}', expected beta’s ${ctx.beta.fqdn}`);
      if (entry.peerId !== ctx.state.peerIdOnCore) problems.push(`peerId=${entry.peerId}`);
      if (entry.outcome !== 'served' || !entry.ok) problems.push(`outcome=${entry.outcome} status=${entry.status}`);
      // att 1/1 is normal here, but 1/2 and 2/2 are equally legal and must not FAIL the step.
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
  {
    id: '5.2.4',
    title: 'Beta’s own routing log shows the matching inbound row',
    on: 'beta',
    wire: `GET ${POOL}/routing-log?limit=5`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const since = ctx.state.marks['5.2'];
      if (!since) return blocked('5.2.2 did not run');
      const log = await getRoutingLog(ctx.beta, 5);
      if (!log.ok) return fail(httpSummary(log));
      const inbound = entriesSince(log.json, since, (entry) => entry.direction === 'inbound' && entry.path === '/v1/chat/completions');
      if (inbound.length === 0) return fail('no inbound entry — beta never received the forward, so core’s 5.2.3 row is contradictory');
      const entry = inbound[0];
      const problems = [];
      if (ctx.core.fqdn && entry.node !== ctx.core.fqdn) problems.push(`node='${entry.node}'`);
      if (entry.candidates !== 1 || entry.attempt !== 1) problems.push(`att ${entry.attempt}/${entry.candidates}`);
      if (entry.outcome !== 'served' || !entry.ok) {
        problems.push(
          `outcome=${entry.outcome} status=${entry.status} — ${entry.status === 403 ? 'Peer is not connected' : entry.status === 503 ? 'inbound off or this peer disabled' : 'refused'}`,
        );
      }
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
  {
    id: '5.2.5',
    title: 'MANUAL: restart core’s engine before continuing',
    on: 'core',
    wire: 'no API route restarts an engine',
    tier: 'readonly',
    manualAction: 'core$ docker start <core ollama container>',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const own = await servesLocally(ctx.core, ctx.state.models.both);
      if (own.error) return fail(own.error);
      if (own.serves && !own.status.localNode?.capabilitiesError)
        return pass('core’s engine is up and serving <model-both> — 5.3’s precondition is met');
      if (!ctx.opts.interactive) return manual('core’s engine is not serving <model-both>; restart it, then re-run');
      await promptOperator(ctx, 'Start core’s inference engine now, then press Enter.');
      const back = await until(
        async () => {
          const again = await servesLocally(ctx.core, ctx.state.models.both);
          return !again.error && again.serves && !again.status.localNode?.capabilitiesError ? again : null;
        },
        { budgetMs: 120_000, intervalMs: 5000 },
      );
      return back
        ? manual('core’s engine confirmed back up')
        : fail('core’s engine did not come back within 2 minutes — 5.3 cannot run and the fleet is left dirty');
    },
  },
  {
    id: '5.3.1',
    title: '5.3 preflight: both engines up, pair connected, routing active',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const res = await getStatus(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      const peer = findPeerRow(status.peers, ctx.beta.fqdn) ?? status.peers?.[0];
      const problems = [];
      if (status.routingActive !== true) problems.push(`routingActive=false (reason '${status.reason}')`);
      if (status.localNode?.capabilitiesError) problems.push(`core capabilitiesError: ${status.localNode.capabilitiesError}`);
      if (!backendsHold(status.localNode?.backends, ctx.state.models.both)) problems.push('core does not hold <model-both>');
      if (!peer || peer.status !== 'connected' || !backendsHold(peer.lastCapabilities?.backends, ctx.state.models.both))
        problems.push('beta is not a live candidate for <model-both>');
      return problems.length
        ? blocked(`5.3 is about the commit boundary between two live candidates and is meaningless with one: ${problems.join('; ')}`)
        : pass('two live candidates, routing active');
    },
  },
  {
    id: '5.3.2',
    title: '5.3 Open a long streamed generation and capture the raw bytes',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (stream:true, raw capture)`,
    tier: 'execute',
    would: 'open a long streaming completion on core and append every wire chunk to an in-memory capture, never buffering it through response.text()',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      ctx.state.marks['5.3'] = Date.now();
      const held = await openHeldStream(ctx, ctx.core, ctx.state.models.both, 'write 2000 words about tides', '5.3 capture');
      held.capturing = true;
      if (!held.ok) return fail(`stream headers ${held.status || 'never arrived'}${held.error ? `: ${held.error}` : ''}`);
      const gotFrame = await until(async () => (held.chunks > 0 ? held.chunks : null), { budgetMs: INFER_TIMEOUT_MS, intervalMs: 250 });
      if (!gotFrame) return fail('no data frame arrived within the header-wait budget');
      ctx.state.capture = held;
      return pass(`200 headers committed and ${held.chunks} raw chunk(s) captured; the stream is open`);
    },
  },
  {
    id: '5.3.3',
    title: '5.3 MANUAL: kill the serving engine while tokens are flowing',
    on: 'core',
    wire: 'no HTTP route kills an engine, and the kill must land inside the streaming window',
    tier: 'readonly',
    manualAction: 'On the node the runner names below: docker stop <that node’s ollama container>, while tokens are still flowing.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const held = ctx.state.capture;
      if (!held) return blocked('5.3.2 did not run, so there is no open stream to interrupt');
      // Name the serving node before prompting: the doc kills core's engine and assumes core is
      // serving, which is right at the default affinity but must not be assumed.
      const log = await getRoutingLog(ctx.core, 1);
      const serving = log.json?.entries?.[0]?.node ?? 'unknown';
      if (!ctx.opts.interactive)
        return manual(`the 5.3.2 request landed on '${serving}' — kill THAT node’s engine while it streams, then re-run --only 5.3`);
      await promptOperator(ctx, `The open stream is being served by '${serving}'. Kill that node's engine now, then press Enter.`);
      const ended = await until(async () => (held.finished ? held : null), { budgetMs: 60_000, intervalMs: 500 });
      if (!ended) return blocked('the stream is still running after the kill was confirmed — the wrong node was hit');
      if (!held.error)
        return blocked(
          'the stream ended cleanly — the kill landed after the generation finished; re-run 5.3.2 with a longer prompt (INCONCLUSIVE, not a result)',
        );
      return manual(`stream terminated with a transport error (${held.error}) after ${held.chunks} chunk(s) — 5.3.4 can now judge the capture`);
    },
  },
  {
    id: '5.3.4',
    title: '5.3 The capture holds exactly one answer — the commit-boundary assertion',
    on: 'core',
    wire: 'pure assertion over the bytes captured in 5.3.2 — no HTTP call',
    tier: 'readonly',
    async run(ctx) {
      const held = ctx.state.capture;
      if (!held) return blocked('no capture from 5.3.2');
      if (!held.finished) return blocked('the captured stream is still open — 5.3.3 has not happened yet');
      const text = Buffer.concat(held.capture).toString('utf8');
      if (text.length === 0) return blocked('the capture is empty');
      const problems = [];
      const roles = text.split('"role":"assistant"').length - 1;
      if (roles > 1) problems.push(`"role":"assistant" occurs ${roles} times — a second generation was started on top of the first`);
      if (/^HTTP\/1\.[01] \d{3}/m.test(text)) problems.push('an HTTP status line appears inside the body');
      const frames = text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]');
      const restarts = frames.slice(1).filter((line) => /"delta":\{("role":"assistant")?\}/.test(line) || /"content":""/.test(line)).length;
      if (frames.length > 2 && restarts > 1) problems.push(`${restarts} frames carry a first-chunk shape after content had flowed`);
      const tail = text.trimEnd().split('\n').pop() ?? '';
      if (/^\s*\{\s*"error"/.test(tail)) problems.push('a complete JSON error object was appended after generated tokens');
      return problems.length
        ? fail(`commit boundary violated: ${problems.join('; ')}`)
        : pass(`${text.length} bytes, one assistant role, no status line, no trailing error object — the client can tell where the answer ends`);
    },
  },
  {
    id: '5.3.5',
    title: '5.3 MANUAL: restart the engine killed in 5.3.3',
    on: 'both',
    wire: 'no API route restarts an engine',
    tier: 'readonly',
    manualAction: 'Restart whichever engine 5.3.3 stopped, before entering section 6 — 6.1 measures a strike counter from a clean baseline.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const own = await servesLocally(ctx.core, ctx.state.models.both);
      if (own.error) return fail(own.error);
      const seen = await peerServes(ctx.core, ctx.beta.fqdn, ctx.state.models.both);
      const healthy = own.serves && !own.status.localNode?.capabilitiesError && seen.serves && (seen.peer?.consecutiveFailures ?? 0) === 0;
      return healthy
        ? pass('both engines healthy and the peer row is clean — section 6 may start')
        : manual(
            `restart the stopped engine (core serves=${own.serves}, peer serves=${seen.serves}, failures=${seen.peer?.consecutiveFailures ?? '-'})`,
          );
    },
  },
];

const SECTION_6 = [
  {
    id: '6.1.1',
    title: 'Read the poll cadence and the starting strike count',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getStatus(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const seconds = pollSeconds(res.json);
      ctx.state.pollSeconds = seconds;
      const peer = findPeerRow(res.json.peers, ctx.beta.fqdn) ?? res.json.peers?.[0];
      if (!peer) return blocked('no peer row on core');
      ctx.state.recoveryBaseline = { lastSeenAt: peer.lastSeenAt, id: peer.id };
      if (peer.status !== 'connected' || peer.consecutiveFailures !== 0) {
        return blocked(
          `peer is status='${peer.status}' failures=${peer.consecutiveFailures} — 6.1 cannot measure a clean three-strike walk from here`,
        );
      }
      // "about 90 seconds at the default cadence" is one configuration, not a constant.
      return pass(
        `poolHealthPollSeconds=${seconds}; strike budget ${UNREACHABLE_THRESHOLD} x (${seconds}s + ${PROBE_TIMEOUT_MS / 1000}s probe timeout); baseline failures 0`,
      );
    },
  },
  {
    id: '6.1.2',
    title: 'MANUAL: take beta off the tailnet (with an automated substitute)',
    on: 'beta',
    wire: `PATCH ${POOL}/settings {"poolEnabled":false}  (substitute only — reported as 6.1 (substitute))`,
    tier: 'execute',
    would:
      'PATCH {"poolEnabled":false} on beta as a SUBSTITUTE for `tailscale down`: beta’s GET capabilities then throws 503 by design and drives core’s strike counter through the identical catch branch. Reversed unconditionally by 6.2.1.',
    manualAction:
      'beta$ tailscale down  (the real test; the substitute does not exercise DNS/TLS failure, the 8s connect timeout, or Tailscale re-establishment)',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await call(ctx.beta, `${POOL}/settings`, { method: 'PATCH', body: { poolEnabled: false } });
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.mustRestore.betaPoolEnabled = true;
      const status = await getStatus(ctx.beta);
      if (status.json?.enabled !== false || status.json?.disabledBy !== 'setting') {
        return fail(
          `the PATCH did not take (enabled=${status.json?.enabled} disabledBy=${status.json?.disabledBy}) — abort rather than waiting on a strike counter that will never move`,
        );
      }
      return pass(
        'SUBSTITUTE in force: beta reports enabled=false disabledBy=setting, so its capabilities probe now 503s. This is NOT `tailscale down` and must be reported as 6.1 (substitute).',
      );
    },
  },
  {
    id: '6.1.3',
    title: 'Strike counter climbs one per poll, then the row flips to unreachable',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const budgetMs = UNREACHABLE_THRESHOLD * (seconds * 1000 + PROBE_TIMEOUT_MS) + 15_000;
      const observed = new Set();
      let earlyEviction = null;
      const done = await until(
        async () => {
          const res = await getPeers(ctx.core);
          if (!res.ok) return null;
          const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
          if (!peer) return null;
          observed.add(`${peer.consecutiveFailures}/${peer.status}`);
          if (peer.status === 'unreachable' && peer.consecutiveFailures < UNREACHABLE_THRESHOLD) {
            earlyEviction = peer.consecutiveFailures;
            return peer;
          }
          return peer.status === 'unreachable' ? peer : null;
        },
        { budgetMs, intervalMs: Math.max(1000, Math.round((seconds * 1000) / 3)) },
      );
      const walk = [...observed].join(' -> ');
      if (earlyEviction !== null)
        return fail(`peer went unreachable at consecutiveFailures=${earlyEviction} — a single failure must not evict a peer (walk: ${walk})`);
      if (!done) {
        const res = await getPeers(ctx.core);
        const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
        if ((peer?.consecutiveFailures ?? 0) >= UNREACHABLE_THRESHOLD && peer.status === 'connected') {
          return fail(`consecutiveFailures=${peer.consecutiveFailures} but status is still 'connected' — the threshold is not being applied`);
        }
        return blocked(`peer did not reach 'unreachable' within ${Math.round(budgetMs / 1000)}s (walk: ${walk || 'no observations'})`);
      }
      return pass(`walked ${walk}; unreachable only at consecutiveFailures >= ${UNREACHABLE_THRESHOLD}`);
    },
  },
  {
    id: '6.1.4',
    title: 'An unreachable peer is no longer even ranked',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions then GET ${POOL}/routing-log`,
    tier: 'execute',
    would:
      'POST /v1/chat/completions on core for <model-both> and check the log records candidates=1, attempt=1 — the unreachable peer is absent from selection, not ranked last',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      if (!res.ok) return fail(httpSummary(res));
      const found = await newestOutbound(ctx.core, ctx.state.models.both, since);
      if (found.error) return fail(found.error);
      if (!found.entry) return fail('no outbound entry for the request');
      const entry = found.entry;
      const problems = [];
      if (entry.node !== LOCAL_NODE) problems.push(`node='${entry.node}'`);
      if (entry.candidates !== 1) problems.push(`candidates=${entry.candidates} — beta is still being ranked despite being unreachable`);
      if (entry.attempt !== 1 || (entry.failedOverFrom ?? []).length)
        problems.push(`att ${entry.attempt} failedOverFrom=[${(entry.failedOverFrom ?? []).join(', ')}]`);
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
  {
    id: '6.1.5',
    title: 'A beta-only model now 502s on core — and PASS here IS a 502',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (<model-beta>)`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-beta> with beta gone. The PASS condition is a 502 no-candidates, not a 200.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (res.status === 200) return fail('HTTP 200 — something still routed to a node that is gone');
      if (res.status !== 502) return fail(httpSummary(res));
      const kind = classify502(res, ctx.state.models.beta);
      if (kind === 'all-unreachable') return fail('502 all-unreachable — a candidate WAS produced and tried, contradicting 6.1.4');
      if (kind !== 'no-candidates') return fail(`502 with an unexpected body: ${errorText(res)}`);
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      const entry = found.entry;
      if (!entry) return pass('502 no-candidates (the routing-log row was not visible in the window)');
      const problems = [];
      if (entry.candidates !== 0) problems.push(`candidates=${entry.candidates}, expected 0`);
      if (entry.attempt !== 0) problems.push(`attempt=${entry.attempt}, expected 0`);
      if (entry.node !== null || entry.peerId !== null || entry.backend !== null)
        problems.push(`node=${entry.node} peerId=${entry.peerId} backend=${entry.backend}, expected all null`);
      if (entry.outcome !== 'failed' || entry.status !== null) problems.push(`outcome=${entry.outcome} status=${entry.status}`);
      return problems.length
        ? fail(`502 no-candidates but the log row is wrong: ${problems.join('; ')}`)
        : pass('502 no-candidates, logged with candidates=0 attempt=0 node=null outcome=failed status=null');
    },
  },
  {
    id: '6.2.1',
    title: 'MANUAL: put beta back on the tailnet (or reverse the substitute)',
    on: 'beta',
    wire: `PATCH ${POOL}/settings {"poolEnabled":true}`,
    tier: 'execute',
    would:
      'PATCH {"poolEnabled":true} on beta, reversing 6.1.2’s substitute. Issued whether or not the section passed — a node left with pooling disabled is the one way this section can damage the fleet.',
    manualAction: 'beta$ tailscale up  (if 6.1.2 used the real form rather than the substitute)',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await call(ctx.beta, `${POOL}/settings`, { method: 'PATCH', body: { poolEnabled: true } });
      if (!res.ok) return fail(`FLEET LEFT DIRTY on beta — reverse with PATCH ${POOL}/settings {"poolEnabled":true}: ${httpSummary(res)}`);
      const status = await getStatus(ctx.beta);
      if (status.json?.enabled !== true || status.json?.disabledBy !== null) {
        return fail(`beta still reports enabled=${status.json?.enabled} disabledBy=${status.json?.disabledBy} — FLEET LEFT DIRTY`);
      }
      ctx.state.mustRestore.betaPoolEnabled = false;
      ctx.state.marks['6.2'] = Date.now();
      return pass('beta reports enabled=true disabledBy=null — the substitute is reversed and the 6.2.2 clock starts here');
    },
  },
  {
    id: '6.2.2',
    title: 'Core recovers the peer within one poll, with no operator action',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const baseline = ctx.state.recoveryBaseline ?? {};
      const before = ctx.state.mutationsDuringRecovery ?? 0;
      const recovered = await until(
        async () => {
          const res = await getPeers(ctx.core);
          if (!res.ok) return null;
          const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
          if (!peer) return null;
          const newer = !baseline.lastSeenAt || (peer.lastSeenAt && Date.parse(peer.lastSeenAt) > Date.parse(baseline.lastSeenAt));
          const healthy =
            peer.status === 'connected' &&
            peer.consecutiveFailures === 0 &&
            (peer.lastCapabilities?.backends ?? []).some((backend) => backend.healthy === true);
          return healthy && newer ? peer : null;
        },
        { budgetMs: seconds * 1000 + PROBE_TIMEOUT_MS + 15_000, intervalMs: 3000 },
      );
      // "with no operator action" is the assertion, so the runner records that it issued none.
      const issued = (ctx.state.mutationsDuringRecovery ?? 0) - before;
      if (!recovered)
        return fail(
          `peer stayed unreachable past ${Math.round((seconds + 8) / 1)}s — record this before working around it; if unpairing is the only way back, recovery is broken`,
        );
      return pass(`peer back to connected/0 failures with a fresh lastSeenAt, and the runner issued ${issued} mutating pool calls in the window`);
    },
  },
  {
    id: '6.2.3',
    title: 'A beta-only model routes to beta again',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (<model-beta>)`,
    tier: 'execute',
    would:
      'POST /v1/chat/completions on core for <model-beta> AFTER 6.2.2 observed the flip — never concurrently, or a 502 is a race rather than a result',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (res.status === 502) return fail(`502 after 6.2.2 passed — the row is connected but its capabilities did not repopulate: ${errorText(res)}`);
      if (!res.ok) return fail(httpSummary(res));
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      const entry = found.entry;
      if (!entry) return fail('no outbound entry for the request');
      if (entry.node === LOCAL_NODE) {
        return blocked('node=local — core also holds <model-beta>, so the section-1.4 inventory precondition was violated; re-pick <model-beta>');
      }
      const problems = [];
      if (ctx.beta.fqdn && entry.node !== ctx.beta.fqdn) problems.push(`node='${entry.node}'`);
      if (entry.peerId !== ctx.state.peerIdOnCore) problems.push(`peerId=${entry.peerId}`);
      if (entry.outcome !== 'served' || !entry.ok) problems.push(`outcome=${entry.outcome} status=${entry.status}`);
      return problems.length ? fail(`${describeEntry(entry)} — ${problems.join('; ')}`) : pass(describeEntry(entry));
    },
  },
];
// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 7: kill switches
//
// The doc writes this section entirely in `cihub` commands; none is an HTTP route. The mapping:
//   cihub pool status                       -> GET   /status
//   cihub pool peers                        -> GET   /peers
//   cihub pool enable|disable [--in|--out]  -> PATCH /settings {poolEnabled|poolInboundEnabled|poolOutboundEnabled}
//   cihub pool peer-disable|peer-enable     -> POST  /peers/:id/disable|/enable   (FULL uuid, not a prefix)
//   cihub pool unpair <fqdn>                -> DELETE /peers/:id                  (uuid, not an FQDN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The settings a restore can actually write back.
 *
 * Exactly the fields of `UpdateHubPoolPreferencesBody` (hub-pool.dto.ts:132-171). `poolPins` is
 * deliberately absent: it is NOT a field of that schema, so zod strips it — a pin can only be
 * written back through `POST /pins`, which is why this runner never deletes one it did not create.
 */
const SETTINGS_RESTORE_KEYS = [
  'poolEnabled',
  'poolOutboundEnabled',
  'poolInboundEnabled',
  'poolLocalAffinity',
  'poolHealthPollSeconds',
  'poolRequireSignedPeers',
  'poolPressureWeight',
];

/** PATCH one settings field and confirm nothing else moved from the startup snapshot. */
async function patchSetting(ctx, node, field, value) {
  const res = await call(node, `${POOL}/settings`, { method: 'PATCH', body: { [field]: value } });
  ctx.state.mutationsDuringRecovery = (ctx.state.mutationsDuringRecovery ?? 0) + 1;
  if (!res.ok) return { ok: false, res };
  ctx.state.mustRestore.settings.add(node.label);
  const snapshot = ctx.state.settingsSnapshot[node.label];
  const drifted = [];
  if (snapshot) {
    for (const [key, before] of Object.entries(snapshot)) {
      if (key === field || key === 'poolPins') continue;
      if (JSON.stringify(res.json?.[key]) !== JSON.stringify(before))
        drifted.push(`${key}: ${JSON.stringify(before)} -> ${JSON.stringify(res.json?.[key])}`);
    }
  }
  return { ok: res.json?.[field] === value && drifted.length === 0, res, drifted, value: res.json?.[field] };
}

/** Poll one node's view of a peer until a predicate holds. */
async function waitForPeerView(node, peerFqdn, predicate, budgetMs) {
  return until(
    async () => {
      const res = await getStatus(node);
      if (!res.ok) return null;
      const peer = findPeerRow(res.json.peers, peerFqdn) ?? res.json.peers?.[0];
      return peer && predicate(peer, res.json) ? { peer, status: res.json } : null;
    },
    { budgetMs, intervalMs: 3000 },
  );
}

/** The 502 the kill-switch steps assert. Prefix, never equality — a routing pin appends a sentence. */
async function expect502NoCandidates(ctx, path, model) {
  const res = await poolInfer(ctx.core, path, { model, messages: [{ role: 'user', content: 'hi' }], stream: false });
  if (res.status === 400)
    return blocked(`400 ${errorText(res)} — the runner sent a malformed body (the doc's curl for this step omits Content-Type)`);
  if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
  if (res.status === 200) return fail('HTTP 200 — core still routed to a node that is out of the pool');
  if (res.status !== 502) return fail(httpSummary(res));
  const kind = classify502(res, model);
  if (kind === 'no-candidates') return pass(`502 "No pool node currently has model ..." as required`);
  return fail(
    kind === 'all-unreachable'
      ? '502 all-unreachable — candidates existed and were tried; the switch did not remove the peer from selection'
      : `502 with an unexpected body: ${errorText(res)}`,
  );
}

const SECTION_7 = [
  {
    id: '7.0',
    title: 'Build gate: does this Hub speak Hub Pool at all?',
    on: 'both',
    wire: `GET ${POOL}/identify`,
    tier: 'readonly',
    async run(ctx) {
      const lines = [];
      for (const node of [ctx.core, ctx.beta]) {
        if (!node.hasPool) {
          lines.push(`${node.label}: ${node.isHub ? 'predates Hub Pool (404 on /identify) — sections 7-10 are skipped for it' : 'not a CI-Hub API'}`);
          continue;
        }
        lines.push(
          `${node.label}: poolProtocol ${node.legacyIdentify ? '1 (inferred: the field is absent, so the directional and per-peer switches may not exist)' : node.protocol}`,
        );
      }
      const anyPool = ctx.core.hasPool || ctx.beta.hasPool;
      return anyPool ? pass(lines.join(' | ')) : blocked(lines.join(' | '));
    },
  },
  {
    id: '7.0b',
    title: 'Operator credential works, and the settings match the startup snapshot',
    on: 'both',
    wire: `GET ${POOL}/settings`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const lines = [];
      for (const node of [ctx.core, ctx.beta]) {
        const res = await getSettings(node);
        if (res.status === 401)
          return fail(`${node.label}: 401 — the operator token is wrong or missing. This is NOT one of the 401s section 9.2 provokes; fail fast.`);
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        // The snapshot teardown restores from is taken in main() before ANY step runs — a section 6
        // interrupted before section 7 must still be reversible. This only refreshes it if that
        // capture could not happen (no credential at the time), and never overwrites it otherwise.
        ctx.state.settingsSnapshot[node.label] ??= res.json;
        lines.push(
          `${node.label}: poll ${res.json.poolHealthPollSeconds}s affinity ${res.json.poolLocalAffinity} enabled=${res.json.poolEnabled} out=${res.json.poolOutboundEnabled} in=${res.json.poolInboundEnabled}`,
        );
      }
      return pass(`operator credential accepted on both nodes — ${lines.join(' | ')}`);
    },
  },
  {
    id: '7.1a',
    title: 'MANUAL: set HUB_POOL_USER_DISABLED=true in beta’s env file and restart beta',
    on: 'beta',
    wire: 'no HTTP route can set an env var — that is the point of the flag',
    tier: 'readonly',
    manualAction: 'beta$ add HUB_POOL_USER_DISABLED=true to the Hub env file and restart the stack, then re-run --only 7',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const peers = await getPeers(ctx.core);
      const row = findPeerRow(peers.json, ctx.beta.fqdn) ?? peers.json?.[0];
      if (!row) return blocked('core holds no connected beta row to capture a BEFORE snapshot from');
      ctx.state.envFlagBaseline = { id: row.id, nodeFqdn: row.nodeFqdn, status: row.status };
      return manual(`BEFORE captured: peer row ${String(row.id).slice(0, 8)} is '${row.status}'. Set the env flag on beta and restart it.`);
    },
  },
  {
    id: '7.1b',
    title: 'Beta reports the master switch off, attributed to the env',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      if (status.enabled === true)
        return blocked('beta reports enabled=true — the env flag from 7.1a is not in force (this step needs the manual action first)');
      const problems = [];
      if (status.disabledBy !== 'env')
        problems.push(`disabledBy='${status.disabledBy}' — the flag is not being read (wrong env file, or not restarted)`);
      if (status.reason !== 'disabled_by_env') problems.push(`reason='${status.reason}'`);
      if (status.directions?.outbound?.enabled !== false || status.directions?.inbound?.enabled !== false)
        problems.push('the master switch did not short-circuit both directions');
      return problems.length ? fail(problems.join('; ')) : pass('enabled=false disabledBy=env reason=disabled_by_env, both directions off');
    },
  },
  {
    id: '7.1c',
    title: 'Core marks beta unreachable but keeps the pairing row',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const budgetMs = UNREACHABLE_THRESHOLD * (seconds * 1000 + PROBE_TIMEOUT_MS) + 15_000;
      const baselineId = ctx.state.envFlagBaseline?.id;
      const done = await until(
        async () => {
          const res = await getPeers(ctx.core);
          if (!res.ok) return null;
          const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
          if (!peer) return { gone: true };
          return peer.status === 'unreachable' && peer.consecutiveFailures >= UNREACHABLE_THRESHOLD ? { peer } : null;
        },
        { budgetMs, intervalMs: Math.max(1000, Math.round((seconds * 1000) / 3)) },
      );
      if (done?.gone) return fail('the beta row disappeared — a kill switch that discards pairing state turns an opt-out into a re-pair');
      if (!done) {
        const res = await getPeers(ctx.core);
        const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
        return blocked(
          `peer is status='${peer?.status}' failures=${peer?.consecutiveFailures} after ${Math.round(budgetMs / 1000)}s — has the env flag actually been set on beta?`,
        );
      }
      if (baselineId && done.peer.id !== baselineId)
        return fail(
          `the peer row id changed (${String(baselineId).slice(0, 8)} -> ${String(done.peer.id).slice(0, 8)}) — the pairing was not preserved`,
        );
      return pass(`row survives with the same id, status='unreachable' failures=${done.peer.consecutiveFailures}`);
    },
  },
  {
    id: '7.1d',
    title: 'A beta-only model now 502s on core instead of being routed',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (<model-beta>)`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-beta> while beta has left the pool — a 502 no-candidates is the PASS',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      return expect502NoCandidates(ctx, '/v1/chat/completions', ctx.state.models.beta);
    },
  },
  {
    id: '7.2a',
    title: 'Turn the in-product setting back on while the env flag is still in force',
    on: 'beta',
    wire: `PATCH ${POOL}/settings {"poolEnabled":true}`,
    tier: 'execute',
    would: 'PATCH {"poolEnabled":true} on beta. Expected to SUCCEED — it writes the persisted half only.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const patched = await patchSetting(ctx, ctx.beta, 'poolEnabled', true);
      if (!patched.res?.ok) return fail(httpSummary(patched.res));
      return patched.value === true ? pass('PATCH succeeded and the stored poolEnabled is true') : fail(`returned poolEnabled=${patched.value}`);
    },
  },
  {
    id: '7.2b',
    title: 'The env flag still beats the setting',
    on: 'beta',
    wire: `GET ${POOL}/status (settings.poolEnabled vs enabled/disabledBy)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      if (status.settings?.poolEnabled !== true) return blocked(`settings.poolEnabled=${status.settings?.poolEnabled} — 7.2a has not been applied`);
      if (status.enabled === true) {
        return status.disabledBy === null
          ? blocked('beta reports enabled=true with no env override in force — this step needs 7.1a’s flag set')
          : fail('enabled=true while the env override should hold — the operator has been told pooling is on when it is not');
      }
      const problems = [];
      if (status.disabledBy !== 'env') problems.push(`disabledBy='${status.disabledBy}'`);
      if (status.reason !== 'disabled_by_env') problems.push(`reason='${status.reason}'`);
      // The doc's PASS ("the output does not claim success it did not deliver") is CLI copy with no
      // HTTP contract; the split below is the whole of what the API can be held to.
      return problems.length
        ? fail(problems.join('; '))
        : pass(
            'settings.poolEnabled=true (as stored) while enabled=false disabledBy=env (effective) — API half verified; the CLI wording is not covered',
          );
    },
  },
  {
    id: '7.3a',
    title: 'MANUAL: delete the HUB_POOL_USER_DISABLED line from beta’s env file and restart',
    on: 'beta',
    wire: 'env edit plus a container restart',
    tier: 'readonly',
    manualAction: 'beta$ remove HUB_POOL_USER_DISABLED from the Hub env file and restart the stack, then re-run --only 7',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      return res.json.disabledBy === 'env'
        ? manual('the env flag is still in force on beta — remove it and restart')
        : pass('no env override in force on beta');
    },
  },
  {
    id: '7.3b',
    title: 'Beta reports pooling enabled again',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      if (res.json.enabled === true && res.json.disabledBy === null) return pass('enabled=true disabledBy=null');
      return fail(
        res.json.disabledBy === 'env'
          ? 'still disabledBy=env — the line was not removed or beta was not restarted'
          : `disabledBy='${res.json.disabledBy}' — 7.2a’s PATCH never landed`,
      );
    },
  },
  {
    id: '7.3c',
    title: 'Core recovers beta to connected on its own, with no re-pair',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const baselineId = ctx.state.envFlagBaseline?.id;
      const back = await until(
        async () => {
          const res = await getPeers(ctx.core);
          if (!res.ok) return null;
          const peer = findPeerRow(res.json, ctx.beta.fqdn) ?? res.json?.[0];
          return peer && peer.status === 'connected' && peer.consecutiveFailures === 0 ? peer : null;
        },
        { budgetMs: 2 * (seconds * 1000 + PROBE_TIMEOUT_MS) + 10_000, intervalMs: 3000 },
      );
      if (!back)
        return fail('the row stayed unreachable past 2 poll intervals — a successful probe is the only path out, so a stuck row is a real defect');
      if (baselineId && back.id !== baselineId) return fail('recovery required a new peer row (i.e. a re-pair)');
      return pass(`same row ${String(back.id).slice(0, 8)} back to connected/0 failures, lastSeenAt ${back.lastSeenAt}`);
    },
  },
  {
    id: '7.3d',
    title: 'A beta-only model routes to beta again',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (<model-beta>)`,
    tier: 'execute',
    would: 'POST /v1/chat/completions on core for <model-beta> and check the log names beta',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (!res.ok) return fail(httpSummary(res));
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      const entry = found.entry;
      if (!entry) return fail('no outbound entry for the request');
      if (entry.node === LOCAL_NODE) return fail('node=local — core served a model it should not have');
      return entry.outcome === 'served' ? pass(describeEntry(entry)) : fail(describeEntry(entry));
    },
  },
  {
    id: '7.4a',
    title: 'Beta stops serving peers but keeps using them (inbound off)',
    on: 'beta',
    wire: `PATCH ${POOL}/settings {"poolInboundEnabled":false}`,
    tier: 'execute',
    would: 'PATCH {"poolInboundEnabled":false} on beta. Reversed by 7.4f and by teardown 10.4.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const patched = await patchSetting(ctx, ctx.beta, 'poolInboundEnabled', false);
      if (!patched.res?.ok) return fail(httpSummary(patched.res));
      if (patched.drifted.length) return fail(`a PATCH must touch only the named field, but ${patched.drifted.join('; ')}`);
      return patched.value === false
        ? pass('poolInboundEnabled=false, every other field unchanged')
        : fail(`returned poolInboundEnabled=${patched.value}`);
    },
  },
  {
    id: '7.4b',
    title: 'Beta’s own status shows one half off, not the master',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      if (status.directions?.inbound?.enabled !== false) return blocked('inbound is not off on beta — 7.4a has not been applied');
      const problems = [];
      if (status.enabled !== true) problems.push(`enabled=${status.enabled} — the directional switch was wired to the master`);
      if (status.disabledBy !== null) problems.push(`disabledBy='${status.disabledBy}'`);
      if (status.directions?.inbound?.disabledBy !== 'setting') problems.push(`inbound.disabledBy='${status.directions?.inbound?.disabledBy}'`);
      if (status.directions?.outbound?.enabled !== true) problems.push('outbound went off too');
      if (status.reason !== 'partially_disabled')
        problems.push(`reason='${status.reason}' — a node serving nothing must not report routing normally`);
      return problems.length ? fail(problems.join('; ')) : pass('enabled=true, inbound off by setting, outbound on, reason=partially_disabled');
    },
  },
  {
    id: '7.4c',
    title: 'Core still sees beta HEALTHY, just not accepting work',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const seen = await waitForPeerView(
        ctx.core,
        ctx.beta.fqdn,
        (peer) => peer.lastCapabilities?.acceptingWork === false,
        2 * (seconds * 1000 + PROBE_TIMEOUT_MS),
      );
      if (!seen) return blocked('core never saw acceptingWork=false within 2 poll intervals — has 7.4a been applied on beta?');
      const problems = [];
      if (seen.peer.status !== 'connected')
        problems.push(
          `status='${seen.peer.status}' — master-switch behaviour leaking into a directional switch, costing three polls to recover from`,
        );
      if (seen.peer.consecutiveFailures !== 0) problems.push(`consecutiveFailures=${seen.peer.consecutiveFailures}`);
      if ((seen.peer.lastCapabilities?.backends ?? []).length !== 0)
        problems.push(`backends is not empty (${seen.peer.lastCapabilities.backends.length})`);
      return problems.length
        ? fail(problems.join('; '))
        : pass('connected, 0 failures, acceptingWork=false with an empty inventory — 200, not 503, by design');
    },
  },
  {
    id: '7.4d',
    title: 'Core refuses the beta-only model rather than shipping it to beta',
    on: 'core',
    wire: `POST ${POOL}/api/chat (<model-beta>)`,
    tier: 'execute',
    would: 'POST /api/chat on core for <model-beta> while beta refuses inbound — a 502 no-candidates is the PASS',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      return expect502NoCandidates(ctx, '/api/chat', ctx.state.models.beta);
    },
  },
  {
    id: '7.4e',
    title: 'Beta can still USE core while refusing to serve it',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const peer = findPeerRow(res.json.peers, ctx.core.fqdn) ?? res.json.peers?.[0];
      if (!peer) return blocked('beta holds no row for core');
      const problems = [];
      if (peer.status !== 'connected' || peer.consecutiveFailures !== 0)
        problems.push(`beta sees core as '${peer.status}' failures=${peer.consecutiveFailures} — the switch is not directional`);
      if (peer.lastCapabilities?.acceptingWork === false) problems.push('beta sees core as not accepting work');
      if (res.json.directions?.outbound?.enabled !== true) problems.push('beta’s outbound went off too');
      if (res.json.routingActive !== true) problems.push('beta stopped using core as well');
      return problems.length ? fail(problems.join('; ')) : pass('beta still sees core connected and accepting work, and still routes to it');
    },
  },
  {
    id: '7.4f',
    title: 'Re-enable inbound on beta and confirm routing resumes with no re-approval',
    on: 'beta',
    wire: `PATCH ${POOL}/settings {"poolInboundEnabled":true}`,
    tier: 'execute',
    would: 'PATCH {"poolInboundEnabled":true} on beta, then re-run 7.3d’s request with no approve call anywhere',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta), modelGate(ctx.state));
      if (stop) return stop;
      const patched = await patchSetting(ctx, ctx.beta, 'poolInboundEnabled', true);
      if (!patched.res?.ok) return fail(httpSummary(patched.res));
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const seen = await waitForPeerView(
        ctx.core,
        ctx.beta.fqdn,
        (peer) => peer.lastCapabilities?.acceptingWork !== false && (peer.lastCapabilities?.backends ?? []).length > 0,
        2 * (seconds * 1000 + PROBE_TIMEOUT_MS),
      );
      if (!seen) return fail('core never saw beta accepting work again within 2 poll intervals');
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (!res.ok) return fail(`routing did not resume: ${httpSummary(res)}`);
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      const entry = found.entry;
      if (!entry || entry.node === LOCAL_NODE) return fail(`routing resumed to '${entry?.node}', expected beta`);
      return pass(`routing resumed with no approve call anywhere: ${describeEntry(entry)}`);
    },
  },
  {
    id: '7.5a',
    title: 'Core stops sending work but keeps serving (outbound off)',
    on: 'core',
    wire: `PATCH ${POOL}/settings {"poolOutboundEnabled":false}`,
    tier: 'execute',
    would: 'PATCH {"poolOutboundEnabled":false} on core. Reversed by 7.5e and by teardown 10.4.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const patched = await patchSetting(ctx, ctx.core, 'poolOutboundEnabled', false);
      if (!patched.res?.ok) return fail(httpSummary(patched.res));
      if (patched.drifted.length) return fail(`another field moved: ${patched.drifted.join('; ')}`);
      return patched.value === false ? pass('poolOutboundEnabled=false, every other field unchanged') : fail(`returned ${patched.value}`);
    },
  },
  {
    id: '7.5b',
    title: 'Core’s status reflects outbound-off',
    on: 'core',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getStatus(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const status = res.json;
      if (status.directions?.outbound?.enabled !== false) return blocked('outbound is not off on core — 7.5a has not been applied');
      const problems = [];
      if (status.enabled !== true) problems.push(`enabled=${status.enabled}`);
      if (status.directions?.outbound?.disabledBy !== 'setting') problems.push(`outbound.disabledBy='${status.directions?.outbound?.disabledBy}'`);
      if (status.directions?.inbound?.enabled !== true) problems.push('inbound went off too');
      if (status.reason !== 'partially_disabled') problems.push(`reason='${status.reason}'`);
      if (status.routingActive !== false) problems.push('routingActive=true with outbound off');
      return problems.length
        ? fail(problems.join('; '))
        : pass('enabled=true, outbound off by setting, inbound on, reason=partially_disabled, routingActive=false');
    },
  },
  {
    id: '7.5c',
    title: 'Core answers 502 for the beta-only model instead of forwarding it',
    on: 'core',
    wire: `POST ${POOL}/api/chat (<model-beta>)`,
    tier: 'execute',
    would: 'POST /api/chat on core for <model-beta> with outbound off — a 502 no-candidates plus a candidates=0 log row is the PASS',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const verdict = await expect502NoCandidates(ctx, '/api/chat', ctx.state.models.beta);
      if (verdict.verdict !== 'PASS') return verdict;
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      const entry = found.entry;
      if (!entry) return pass(`${verdict.reason} (no log row visible in the window)`);
      const problems = [];
      if (entry.candidates !== 0) problems.push(`candidates=${entry.candidates}, expected 0 — usablePeers returns [] when outbound is off`);
      if (entry.outcome !== 'failed') problems.push(`outcome=${entry.outcome}`);
      if (entry.node !== null) problems.push(`node=${entry.node}, expected null`);
      return problems.length ? fail(problems.join('; ')) : pass(`${verdict.reason}; logged candidates=0 outcome=failed node=null`);
    },
  },
  {
    id: '7.5d',
    title: 'Beta still sees core connected and serving',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getStatus(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const peer = findPeerRow(res.json.peers, ctx.core.fqdn) ?? res.json.peers?.[0];
      if (!peer) return blocked('beta holds no row for core');
      const problems = [];
      if (peer.status !== 'connected' || peer.consecutiveFailures !== 0)
        problems.push(`beta sees core as '${peer.status}' failures=${peer.consecutiveFailures}`);
      if (peer.lastCapabilities?.acceptingWork === false) problems.push('beta sees core as not accepting work');
      if ((peer.lastCapabilities?.backends ?? []).length === 0) problems.push('beta sees an empty inventory on core');
      return problems.length
        ? fail(`outbound-off on core must not change what core serves for beta: ${problems.join('; ')}`)
        : pass('beta still sees core connected, accepting work, inventory non-empty');
    },
  },
  {
    id: '7.5e',
    title: 'Restore outbound on core',
    on: 'core',
    wire: `PATCH ${POOL}/settings {"poolOutboundEnabled":true}`,
    tier: 'execute',
    would: 'PATCH {"poolOutboundEnabled":true} on core and confirm routing resumes',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const patched = await patchSetting(ctx, ctx.core, 'poolOutboundEnabled', true);
      if (!patched.res?.ok) return fail(httpSummary(patched.res));
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (!res.ok) return fail(`routing did not resume: ${httpSummary(res)}`);
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      return found.entry && found.entry.node !== LOCAL_NODE
        ? pass(`outbound restored; ${describeEntry(found.entry)}`)
        : fail(`outbound restored but the request landed on '${found.entry?.node}'`);
    },
  },
  {
    id: '7.6a',
    title: 'Resolve beta’s peer id (needed for every per-peer call)',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getPeers(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      const rows = (res.json ?? []).filter((row) => row.nodeFqdn === ctx.beta.fqdn);
      if (rows.length === 0) return blocked('no row on core whose nodeFqdn is beta’s');
      if (rows.length > 1) return fail(`${rows.length} rows share beta’s nodeFqdn (node_fqdn is UNIQUE, so this should be impossible)`);
      ctx.state.peerIdOnCore = rows[0].id;
      // The CLI accepts an 8-char prefix; the HTTP route takes the FULL uuid as a path param.
      return pass(`peer id ${rows[0].id} (full uuid — the route does not accept a prefix)`);
    },
  },
  {
    id: '7.6b',
    title: 'Per-peer kill switch: disable beta on core',
    on: 'core',
    wire: `POST ${POOL}/peers/{id}/disable`,
    tier: 'execute',
    would: 'POST /peers/<beta uuid>/disable on core. Reversible and symmetric — the pairing and both tokens survive.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      if (!ctx.state.peerIdOnCore) return blocked('no peer id resolved (7.6a)');
      const res = await call(ctx.core, `${POOL}/peers/${ctx.state.peerIdOnCore}/disable`, { method: 'POST', body: {} });
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.mustRestore.peerEnabled = true;
      const problems = [];
      if (res.json?.enabled !== false) problems.push(`enabled=${res.json?.enabled}`);
      if (res.json?.status !== 'connected') problems.push(`status changed to '${res.json?.status}'`);
      if ('verifyTokenHash' in (res.json ?? {}) || 'presentTokenEncrypted' in (res.json ?? {}))
        problems.push('a token field leaked into the response');
      return problems.length ? fail(problems.join('; ')) : pass('enabled=false with status still connected, no token fields');
    },
  },
  {
    id: '7.6c',
    title: 'Beta prints connected/off and is still polled successfully',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const first = await getPeers(ctx.core);
      if (!first.ok) return fail(httpSummary(first));
      const before = findPeerRow(first.json, ctx.beta.fqdn);
      if (!before) return fail('the row is gone');
      // `enabled` is optional on a Hub predating the switch: test === false, never falsiness.
      if (before.enabled !== false)
        return blocked(`enabled=${before.enabled ?? 'absent'} — 7.6b has not been applied (or this build predates the per-peer switch)`);
      if (before.status !== 'connected') return fail(`status='${before.status}' — a disabled peer must stay connected`);
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const advanced = await until(
        async () => {
          const res = await getPeers(ctx.core);
          const peer = findPeerRow(res.json, ctx.beta.fqdn);
          return peer?.lastSeenAt && peer.lastSeenAt !== before.lastSeenAt && peer.consecutiveFailures === 0 ? peer : null;
        },
        { budgetMs: 2 * (seconds * 1000 + PROBE_TIMEOUT_MS), intervalMs: 3000 },
      );
      return advanced
        ? pass('connected/off, and lastSeenAt still advancing with 0 failures — a disabled peer is polled on purpose')
        : fail('lastSeenAt stopped advancing on a disabled peer');
    },
  },
  {
    id: '7.6d',
    title: 'No work moves to a disabled peer',
    on: 'core',
    wire: `POST ${POOL}/api/chat (<model-beta>)`,
    tier: 'execute',
    would: 'POST /api/chat on core for <model-beta> with beta disabled — a 502 no-candidates is the PASS',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      return expect502NoCandidates(ctx, '/api/chat', ctx.state.models.beta);
    },
  },
  {
    id: '7.6e',
    title: '…and none in the other direction either (symmetry)',
    on: 'beta',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      const seen = await waitForPeerView(
        ctx.beta,
        ctx.core.fqdn,
        (peer) => peer.lastCapabilities?.acceptingWork === false,
        2 * (seconds * 1000 + PROBE_TIMEOUT_MS),
      );
      if (!seen) return fail('beta still sees core accepting work — the per-peer switch is one-directional');
      const problems = [];
      if ((seen.peer.lastCapabilities?.backends ?? []).length !== 0) problems.push('backends is not empty');
      if (seen.peer.status !== 'connected') problems.push(`beta marked core '${seen.peer.status}' — it should stay healthy`);
      if (seen.peer.consecutiveFailures !== 0) problems.push(`consecutiveFailures=${seen.peer.consecutiveFailures}`);
      return problems.length ? fail(problems.join('; ')) : pass('beta sees core as connected but acceptingWork=false with an empty inventory');
    },
  },
  {
    id: '7.6f',
    title: 'Re-enable restores routing with no approval on beta',
    on: 'core',
    wire: `POST ${POOL}/peers/{id}/enable`,
    tier: 'execute',
    would: 'POST /peers/<beta uuid>/enable on core, then re-run 7.3d’s request with no approve or pair call anywhere',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      if (!ctx.state.peerIdOnCore) return blocked('no peer id resolved (7.6a)');
      const res = await call(ctx.core, `${POOL}/peers/${ctx.state.peerIdOnCore}/enable`, { method: 'POST', body: {} });
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.mustRestore.peerEnabled = false;
      if (res.json?.enabled !== true) return fail(`enabled=${res.json?.enabled}`);
      if (res.json?.id !== ctx.state.peerIdOnCore) return fail('the peer row id changed across enable/disable');
      const seconds = ctx.state.pollSeconds ?? DEFAULT_POLL_SECONDS;
      await waitForPeerView(
        ctx.core,
        ctx.beta.fqdn,
        (peer) => (peer.lastCapabilities?.backends ?? []).length > 0,
        2 * (seconds * 1000 + PROBE_TIMEOUT_MS),
      );
      const since = Date.now();
      const infer = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.beta));
      if (!infer.ok) return fail(`routing did not resume: ${httpSummary(infer)}`);
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since);
      return found.entry && found.entry.node !== LOCAL_NODE
        ? pass(`re-enabled, same row id, routing resumed with no approval: ${describeEntry(found.entry)}`)
        : fail(`request landed on '${found.entry?.node}'`);
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 8: native API coverage
//
// A regression sweep: every app-facing route must exist, and the routed ones must reach the peer.
// A 404 from the proxy is the failure class this section exists to catch — it means every app on
// OLLAMA_HOST breaks the moment a peer connects.
// ─────────────────────────────────────────────────────────────────────────────

/** One routed endpoint: 200, plus a log row naming beta with the UPSTREAM path. */
function routedEndpoint(id, title, path, bodyFor, options = {}) {
  return {
    id,
    title,
    on: 'core',
    wire: `POST ${POOL}${path}`,
    tier: 'execute',
    would: `POST ${path} on core through the pool proxy and check the routing log names beta`,
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const model = options.shared ? ctx.state.models.both : ctx.state.models.beta;
      const since = Date.now();
      const res = await poolInfer(ctx.core, path, bodyFor(model));
      if (res.status === 404) return fail('404 from the proxy — the endpoint is missing from the app-facing surface');
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      if (!res.ok) return fail(httpSummary(res));
      if (options.check) {
        const problem = options.check(res);
        if (problem) return fail(problem);
      }
      const found = await newestOutbound(ctx.core, model, since, 12);
      const rows = (found.all ?? []).filter((entry) => entry.path === path);
      if (rows.length === 0) return fail(`HTTP 200 but no outbound log row with path='${path}'`);
      if (rows.length > 1) return fail(`${rows.length} log rows for one request`);
      const entry = rows[0];
      if (!options.shared && entry.node === LOCAL_NODE) return fail('node=local for a beta-only model');
      return entry.outcome === 'served' ? pass(describeEntry(entry)) : fail(describeEntry(entry));
    },
  };
}

/** One local-only endpoint: it must exist, and that is deliberately all this asserts. */
function localEndpoint(id, title, path, method, bodyFor, check) {
  return {
    id,
    title,
    on: 'core',
    wire: `${method} ${POOL}${path}`,
    // Local-only metadata: no candidate selection, no generation, so it is safe read-only.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      // These routes are served by core's OWN engine. A model id core does not hold gets a 502 from
      // proxyLocalOnlyRequest, which says nothing about whether the route exists.
      if (bodyFor && !ctx.state.coreLocalModel)
        return blocked('core’s own inventory is unknown, so there is no model id this local-only route could be asked about');
      const body = bodyFor ? bodyFor(ctx.state.coreLocalModel) : undefined;
      const res = await call(ctx.core, `${POOL}${path}`, { method, body, auth: 'none' });
      if (res.status === 404) return fail('404 from the proxy — an app pointed at OLLAMA_HOST gets a 404 rather than a fallback');
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      if (!res.ok) return fail(httpSummary(res));
      const problem = check ? check(res) : null;
      // Cross-node merging of the listing endpoints is a recorded v1 limitation, so seeing a peer's
      // models here is explicitly NOT a failure. Assert 200 and the shape only.
      return problem ? fail(problem) : pass('HTTP 200 (served locally, never pooled)');
    },
  };
}

const SECTION_8 = [
  {
    id: '8.0',
    title: 'Snapshot the routing-log summary before the API sweep',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=200`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getRoutingLog(ctx.core, 200);
      if (!res.ok) return fail(httpSummary(res));
      ctx.state.watermark.sweep = res.json.summary?.recorded ?? 0;
      // An EMPTY log is not a failure: it is in-memory and process-local, and the restarts in
      // 7.1a/7.3a wipe it.
      return pass(
        `recorded=${res.json.summary?.recorded} capacity=${res.json.summary?.capacity} served=${res.json.summary?.served} failed=${res.json.summary?.failed}`,
      );
    },
  },
  routedEndpoint('8.1', 'Ollama /api/chat, non-streaming', '/api/chat', (model) => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  })),
  {
    id: '8.2',
    title: 'Ollama /api/chat, streaming',
    on: 'core',
    wire: `POST ${POOL}/api/chat (stream:true)`,
    tier: 'execute',
    would: 'POST /api/chat with stream:true and read the newline-delimited JSON to completion, expecting a final {"done":true} frame',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/api/chat', {
        model: ctx.state.models.beta,
        messages: [{ role: 'user', content: 'count to twenty' }],
        stream: true,
      });
      if (res.status === 404) return fail('404 from the proxy');
      if (!res.ok) return fail(httpSummary(res));
      const lines = (res.text ?? '').split('\n').filter((line) => line.trim().length > 0);
      if (lines.length === 0) return fail('the stream carried no frames');
      let last = null;
      try {
        last = JSON.parse(lines[lines.length - 1]);
      } catch {
        return fail('the last non-empty line is not JSON — truncated stream');
      }
      if (last?.done !== true) return fail('the last frame does not carry done:true');
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since, 12);
      const rows = (found.all ?? []).filter((entry) => entry.path === '/api/chat');
      if (rows.length !== 1) return fail(`${rows.length} log rows for one streaming request`);
      return rows[0].node === LOCAL_NODE
        ? fail('node=local for a beta-only model')
        : pass(`streamed to done:true in ${lines.length} frames; ${describeEntry(rows[0])}`);
    },
  },
  routedEndpoint('8.3', 'Ollama /api/generate', '/api/generate', (model) => ({ model, prompt: 'hi', stream: false })),
  routedEndpoint('8.4', 'Ollama /api/embed', '/api/embed', (model) => ({ model, input: 'hello' }), {
    shared: true,
    check: (res) => (Array.isArray(res.json?.embeddings) ? null : 'HTTP 200 but no embeddings array'),
  }),
  routedEndpoint('8.5', 'Ollama /api/embeddings (legacy shape)', '/api/embeddings', (model) => ({ model, prompt: 'hello' }), {
    shared: true,
    check: (res) => (Array.isArray(res.json?.embedding) ? null : 'HTTP 200 but no flat embedding array'),
  }),
  routedEndpoint('8.6', 'OpenAI /v1/chat/completions, non-streaming', '/v1/chat/completions', (model) => ({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  })),
  {
    id: '8.7',
    title: 'OpenAI /v1/chat/completions, streaming (SSE)',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (stream:true)`,
    tier: 'execute',
    would: 'POST /v1/chat/completions with stream:true and read the SSE to completion, expecting a final `data: [DONE]` frame',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core), modelGate(ctx.state));
      if (stop) return stop;
      const since = Date.now();
      const res = await poolInfer(ctx.core, '/v1/chat/completions', {
        model: ctx.state.models.beta,
        messages: [{ role: 'user', content: 'count to twenty' }],
        stream: true,
      });
      if (res.status === 404) return fail('404 from the proxy');
      if (!res.ok) return fail(httpSummary(res));
      const frames = (res.text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (frames[frames.length - 1] !== 'data: [DONE]')
        return fail(`the stream ended with "${frames[frames.length - 1] ?? 'nothing'}", expected "data: [DONE]"`);
      const found = await newestOutbound(ctx.core, ctx.state.models.beta, since, 12);
      const rows = (found.all ?? []).filter((entry) => entry.path === '/v1/chat/completions');
      if (rows.length !== 1) return fail(`${rows.length} log rows for one streaming request`);
      return rows[0].node === LOCAL_NODE
        ? fail('node=local for a beta-only model')
        : pass(`SSE terminated with data: [DONE]; ${describeEntry(rows[0])}`);
    },
  },
  routedEndpoint('8.8', 'OpenAI /v1/embeddings', '/v1/embeddings', (model) => ({ model, input: 'hello' }), {
    shared: true,
    check: (res) => (Array.isArray(res.json?.data?.[0]?.embedding) ? null : 'HTTP 200 but no data[0].embedding array'),
  }),
  localEndpoint('8.9', 'Ollama /api/tags is served locally, never pooled', '/api/tags', 'GET', null, (res) =>
    Array.isArray(res.json?.models) ? null : 'no models array',
  ),
  localEndpoint('8.10', 'OpenAI /v1/models is served locally', '/v1/models', 'GET', null, (res) =>
    Array.isArray(res.json?.data) ? null : 'no data array',
  ),
  localEndpoint('8.11a', 'Ollama /api/version', '/api/version', 'GET', null, (res) => (res.json?.version === undefined ? 'no version field' : null)),
  localEndpoint('8.11b', 'Ollama /api/ps', '/api/ps', 'GET', null, (res) => (Array.isArray(res.json?.models) ? null : 'no models array')),
  localEndpoint('8.12', 'Ollama /api/show', '/api/show', 'POST', (model) => ({ model }), null),
  {
    id: '8.13',
    title: 'A body with no model is rejected with a 400, not routed',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions {"messages":[]}`,
    // Rejected by proxyToPool's guard clause before candidate selection — no GPU, no state.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      // The 400 itself needs no credential; only the "no new log row" half does, so a missing token
      // narrows this step rather than blocking it.
      const before = ctx.core.token ? await getRoutingLog(ctx.core, 1) : null;
      const res = await poolInfer(ctx.core, '/v1/chat/completions', { messages: [] }, TIMEOUT_MS);
      if (res.status === 403) return blocked(`403 ${errorText(res)} — runner configuration`);
      if (res.status !== 400)
        return fail(
          `HTTP ${res.status}, expected 400${res.status === 502 ? ' — a 502 would mean the request reached candidate selection with an undefined model' : ''}`,
        );
      if (res.json?.error !== NO_MODEL_MESSAGE) return fail(`body was ${JSON.stringify(res.json)}, expected {"error":"${NO_MODEL_MESSAGE}"}`);
      if (!before) return pass('400 with the exact message; the "no new routing-log row" half needs an operator credential and was not checked');
      if (!before.ok) return blocked(`400 with the exact message, but the routing log could not be read: ${httpSummary(before)}`);
      const after = await getRoutingLog(ctx.core, 200);
      if (!after.ok) return blocked(`400 with the exact message, but the routing log could not be read back: ${httpSummary(after)}`);
      // Compared by entry timestamp, not by `summary.recorded` — see `rowsAfter`.
      const fresh = rowsAfter(before.json, after.json, (entry) => entry.direction === 'outbound' && entry.path === '/v1/chat/completions');
      return fresh.length
        ? fail(`a routing-log row appeared (${describeEntry(fresh[0])}) — the handler did not return before candidate selection`)
        : pass('400 with the exact message, and no new routing-log row for the path');
    },
  },
  routedEndpoint('8.14', 'COVERAGE GAP: OpenAI /v1/completions (a real route the doc’s table omits)', '/v1/completions', (model) => ({
    model,
    prompt: 'hi',
    stream: false,
  })),
];
// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 9: security spot-checks
//
// 9.1's 403 is ambiguous by status code alone: InternalNetworkGuard runs FIRST and also throws 403,
// with near-identical wording. A runner whose source IP is rejected would see 403 for everything and
// pass 9.1 vacuously. Two mitigations, both required: the 9.0 baseline, and matching the exact
// PoolAppGuard message.
// ─────────────────────────────────────────────────────────────────────────────

/** One 9.1 probe: the same request, plus one header that must get it refused. */
async function refusedByPoolAppGuard(ctx, headers) {
  const res = await call(ctx.core, `${POOL}/v1/chat/completions`, {
    method: 'POST',
    auth: 'none',
    headers,
    body: { model: probeModel(ctx.state), messages: [{ role: 'user', content: 'hi' }], stream: false },
    timeoutMs: TIMEOUT_MS,
  });
  if (res.status === 200)
    return {
      ok: false,
      detail:
        'HTTP 200 — these routes spend GPU on every paired node, so anything carrying reverse-proxy provenance must be refused whatever the source IP says',
    };
  if (res.status !== 403) return { ok: false, detail: httpSummary(res) };
  const message = typeof res.json?.error === 'string' ? res.json.error : errorText(res);
  if (message === INTERNAL_GUARD_MESSAGE)
    return {
      ok: false,
      detail: 'refused by InternalNetworkGuard, not PoolAppGuard — the runner’s own source IP is the reason, so this proves nothing',
    };
  if (message !== POOL_APP_GUARD_MESSAGE) return { ok: false, detail: `403 with an unexpected message: "${message}"` };
  return { ok: true, detail: '403 with PoolAppGuard’s exact message' };
}

/** One 9.2 probe against a peer-facing route, with the operator credential deliberately stripped. */
async function peerFacing401(ctx, path, method, headers, body) {
  const res = await call(ctx.core, `${POOL}${path}`, { method, auth: 'none', headers, body, timeoutMs: TIMEOUT_MS });
  return { status: res.status, message: errorText(res) };
}

const SECTION_9 = [
  {
    id: '9.0',
    title: 'PRECONDITION for 9.1: the same route WITHOUT tunnel headers gets past both guards',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions (clean headers)`,
    // Deliberately read-only. The doc's control is a real 200, which costs GPU and so would sit
    // behind --execute — and 9.1 would then be unreachable in a safe run, which is the wrong way
    // round for a security check. A clean-headed body with NO `model` is a strictly better control:
    // it reaches proxyToPool's guard clause, so a 400 proves BOTH guards admitted the caller, and it
    // spends nothing. The 200 form still runs on top under --execute.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      const probe = await poolInfer(ctx.core, '/v1/chat/completions', { messages: [] }, TIMEOUT_MS);
      if (probe.status === 403) {
        ctx.state.guardBaseline = false;
        const message = typeof probe.json?.error === 'string' ? probe.json.error : errorText(probe);
        return blocked(
          message === INTERNAL_GUARD_MESSAGE
            ? 'InternalNetworkGuard rejected the runner’s own source IP — 9.1’s 403s would prove nothing, so 9.1 is reported INCONCLUSIVE rather than PASS'
            : `403 "${message}" with clean headers — the runner cannot establish a baseline`,
        );
      }
      if (probe.status !== 400 || probe.json?.error !== NO_MODEL_MESSAGE) {
        ctx.state.guardBaseline = false;
        return blocked(`no clean baseline: ${httpSummary(probe)}`);
      }
      ctx.state.guardBaseline = true;
      if (!ctx.opts.execute || !ctx.state.models.both) {
        return pass('clean headers reach proxyToPool (400 "must include a model") — both guards admitted the caller, so 9.1’s 403s mean something');
      }
      const served = await poolInfer(ctx.core, '/v1/chat/completions', shortChat(ctx.state.models.both));
      return served.status === 200
        ? pass('clean headers reach proxyToPool AND a real request returns 200 — the strongest form of the control')
        : fail(`the guards admitted the caller but a clean real request failed: ${httpSummary(served)}`);
    },
  },
  {
    id: '9.1a',
    title: 'A Cloudflare tunnel marker is refused',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions + cf-ray (and each other marker)`,
    // Rejected by a guard before the handler: no GPU, no state, safe read-only.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      const results = [];
      for (const header of TUNNEL_MARKER_HEADERS) {
        const value = header === 'cf-ray' ? '0000000000000000-TEST' : header === 'cf-visitor' ? '{"scheme":"https"}' : '203.0.113.10';
        const probe = await refusedByPoolAppGuard(ctx, { [header]: value });
        results.push({ header, ...probe });
      }
      const bad = results.filter((row) => !row.ok);
      const rendered = results.map((row) => `${row.header}: ${row.ok ? '403' : row.detail}`).join(' | ');
      if (bad.length === 0) {
        return ctx.state.guardBaseline === true
          ? pass(`all ${results.length} markers refused with PoolAppGuard’s exact message`)
          : blocked(`all markers refused, but 9.0 established no clean baseline — INCONCLUSIVE: ${rendered}`);
      }
      return fail(rendered);
    },
  },
  {
    id: '9.1b',
    title: 'A forwarded chain with a public hop is refused',
    on: 'core',
    wire: `POST ${POOL}/v1/chat/completions + X-Forwarded-For: 203.0.113.10, 172.18.0.2`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      // x-forwarded-for is deliberately NOT a tunnel marker (it is caller-controlled), so this is a
      // distinct code path from 9.1a and both must be run.
      const probe = await refusedByPoolAppGuard(ctx, { 'x-forwarded-for': '203.0.113.10, 172.18.0.2' });
      if (!probe.ok) return fail(probe.detail);
      return ctx.state.guardBaseline === true ? pass(probe.detail) : blocked(`${probe.detail}, but 9.0 established no clean baseline — INCONCLUSIVE`);
    },
  },
  {
    id: '9.1c',
    title: '…and neither refusal reached the router',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=200`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const before = await getRoutingLog(ctx.core, 200);
      if (!before.ok) return fail(httpSummary(before));
      await refusedByPoolAppGuard(ctx, { 'cf-ray': '0000000000000000-TEST' });
      await refusedByPoolAppGuard(ctx, { 'x-forwarded-for': '203.0.113.10, 172.18.0.2' });
      const after = await getRoutingLog(ctx.core, 200);
      if (!after.ok) return fail(httpSummary(after));
      // `summary.recorded` cannot answer this — it is a capacity-capped gauge, so on a Hub that has
      // served 200 pooled requests it is pinned at 200 and the assertion could never fail. The whole
      // point of this step is that a guard threw, so it has to watch the entries themselves.
      const fresh = rowsAfter(before.json, after.json, (entry) => entry.direction === 'outbound' && entry.path === '/v1/chat/completions');
      return fresh.length === 0
        ? pass('no new /v1/chat/completions row in the routing log — the guards threw before the handler')
        : fail(`${fresh.length} new routing-log row(s) (${describeEntry(fresh[0])}) — the request got past the guard far enough to be routed`);
    },
  },
  {
    id: '9.2a',
    title: 'An unpaired device gets 401 on a peer-facing route with no credentials',
    on: 'core',
    wire: `GET ${POOL}/capabilities (no credentials)`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      // The operator bearer is deliberately stripped: with it the route still 401s, but the step
      // would be exercising the wrong branch of PoolPeerGuard.
      const probe = await peerFacing401(ctx, '/capabilities', 'GET', {}, undefined);
      if (probe.status === 401) return pass(`401 "${probe.message}"`);
      return fail(
        `HTTP ${probe.status} — being on the tailnet must not by itself grant use of a peer-facing route${probe.status === 200 || probe.status === 503 ? ' (the guard was reached but not enforced)' : ''}`,
      );
    },
  },
  {
    id: '9.2b',
    title: 'Naming a genuinely paired peer without holding its token still fails',
    on: 'core',
    wire: `GET ${POOL}/capabilities + X-Hub-Pool-Peer + a bogus bearer`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      const peerName = ctx.beta.fqdn ?? 'unknown.example-tailnet.ts.net';
      const probe = await peerFacing401(
        ctx,
        '/capabilities',
        'GET',
        { 'x-hub-pool-peer': peerName, authorization: 'Bearer not-the-real-token' },
        undefined,
      );
      // Any of `Invalid pool peer token`, `Unknown pool peer` or `Invalid pool peer credentials` is
      // a legitimate 401 here, so the status is asserted and the message only reported.
      return probe.status === 401
        ? pass(`401 "${probe.message}" (the row exists, the name is right, only the secret is wrong)`)
        : fail(`HTTP ${probe.status} "${probe.message}"`);
    },
  },
  {
    id: '9.2c',
    title: 'The peer-facing local forward is refused the same way',
    on: 'core',
    wire: `POST ${POOL}/local/api/chat + bogus peer credentials`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core));
      if (stop) return stop;
      const probe = await peerFacing401(
        ctx,
        '/local/api/chat',
        'POST',
        {
          'x-hub-pool-backend': 'ollama',
          'x-hub-pool-peer': ctx.beta.fqdn ?? 'unknown.example-tailnet.ts.net',
          authorization: 'Bearer not-the-real-token',
        },
        { model: probeModel(ctx.state), messages: [{ role: 'user', content: 'hi' }] },
      );
      if (probe.status === 401) return pass(`401 "${probe.message}" — no GPU spent; the guard threw before forwardLocal ran`);
      // 403 / 400 / 503 all mean the guard ADMITTED the caller and the handler is what refused.
      const admitted = [400, 403, 503].includes(probe.status);
      return fail(
        `HTTP ${probe.status} "${probe.message}"${admitted ? ' — the guard admitted the caller and the handler is what refused; that is a real authentication failure however the request ended' : ''}`,
      );
    },
  },
  {
    id: '9.2d',
    title: '…and core’s routing log gained no inbound row',
    on: 'core',
    wire: `GET ${POOL}/routing-log?limit=200`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const since = Date.now();
      await peerFacing401(
        ctx,
        '/local/api/chat',
        'POST',
        {
          'x-hub-pool-backend': 'ollama',
          'x-hub-pool-peer': ctx.beta.fqdn ?? 'unknown.example-tailnet.ts.net',
          authorization: 'Bearer not-the-real-token',
        },
        { model: probeModel(ctx.state), messages: [{ role: 'user', content: 'hi' }] },
      );
      const log = await getRoutingLog(ctx.core, 200);
      if (!log.ok) return fail(httpSummary(log));
      const inbound = entriesSince(log.json, since, (entry) => entry.direction === 'inbound');
      // A genuine 403/503 refusal in forwardLocal DOES write an inbound row, which is exactly why
      // its presence here is a failure signal.
      return inbound.length === 0
        ? pass('no inbound row since the refused forward')
        : fail(`${inbound.length} inbound row(s) appeared — the forward was recorded, so it was admitted`);
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Steps — section 10: teardown
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_10 = [
  {
    id: '10.1',
    title: 'Resolve the peer id to unpair',
    on: 'core',
    wire: `GET ${POOL}/peers`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      const res = await getPeers(ctx.core);
      if (!res.ok) return fail(httpSummary(res));
      if (!ctx.beta.fqdn)
        return blocked('beta’s nodeFqdn is unknown, so no row on core can be attributed to beta — 10.2 must not guess which row to DELETE');
      // Never "the first row": the id resolved here is the one 10.2 deletes, and a wrong guess
      // unpairs some third node this run never touched.
      const row = findPeerRow(res.json, ctx.beta.fqdn);
      if (!row) return skip('core holds no beta row — nothing to tear down');
      ctx.state.peerIdOnCore = row.id;
      // The doc writes `cihub pool unpair <beta-node>`; the route takes the peer's UUID.
      return pass(`peer uuid ${row.id} (the CLI takes an FQDN here; the route takes the uuid)`);
    },
  },
  {
    id: '10.2',
    title: 'Unpair beta from core',
    on: 'core',
    wire: `DELETE ${POOL}/peers/{id}`,
    tier: 'execute',
    would: 'DELETE /peers/<beta uuid> on core — the only call that revokes a credential; the 7.6 disable did not',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core), tokenGate(ctx.core));
      if (stop) return stop;
      if (!ctx.state.peerIdOnCore) return skip('no peer id to unpair');
      const res = await deletePeerRow(ctx.core, ctx.state.peerIdOnCore);
      if (!res.ok || res.json?.success !== true) return fail(httpSummary(res));
      const after = await getPeers(ctx.core);
      const survived = (after.json ?? []).some((row) => row.id === ctx.state.peerIdOnCore);
      ctx.state.paired = false;
      return survived ? fail('the row survived the DELETE') : pass('{success:true}, and core no longer lists beta');
    },
  },
  {
    id: '10.3',
    title: 'Beta’s side cleared too (observation only)',
    on: 'beta',
    wire: `GET ${POOL}/peers`,
    // Strictly a read. The DELETE that repairs a half-cleared pairing lives in 10.3b, behind
    // --execute: unpairing beta from core is a mutation whichever section it appears in, and a
    // default read-only run must not make it.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      const res = await getPeers(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      // Fail closed: without core's name, every row on beta looks like core's, and "clear the stale
      // row" would mean "delete every pairing beta has", third parties included.
      if (!ctx.core.fqdn)
        return blocked(
          'core’s nodeFqdn is unknown (GET /status needs core’s operator credential), so beta’s rows cannot be attributed to core — no row is judged and none is touched',
        );
      const stale = (res.json ?? []).filter((row) => row.nodeFqdn === ctx.core.fqdn);
      if (stale.length === 0) return pass(`beta lists no row for core (${(res.json ?? []).length} row(s) for other nodes)`);
      // Not necessarily a product defect: the unpair callback is best-effort over https://<fqdn>
      // and fails silently on a node with no Tailscale cert.
      return blocked(
        `beta still holds ${stale.length} row(s) for core — the best-effort HTTPS unpair callback did not land. 10.3b clears it under --execute (DELETE ${POOL}/peers/${stale[0].id}).`,
      );
    },
  },
  {
    id: '10.3b',
    title: 'Clear the row beta kept after the unpair',
    on: 'beta',
    wire: `DELETE ${POOL}/peers/{id}`,
    tier: 'execute',
    would:
      'DELETE beta’s row for CORE (and only for core) when the best-effort unpair callback did not reach it, so neither node is left holding half a pairing',
    async run(ctx) {
      const stop = gate(poolGate(ctx.beta), tokenGate(ctx.beta));
      if (stop) return stop;
      if (!ctx.core.fqdn) return blocked(UNATTRIBUTABLE);
      const res = await getPeers(ctx.beta);
      if (!res.ok) return fail(httpSummary(res));
      const stale = (res.json ?? []).filter((row) => row.nodeFqdn === ctx.core.fqdn);
      if (stale.length === 0) return skip('beta holds no row for core — nothing to clear');
      const cleared = [];
      const problems = [];
      for (const row of stale) {
        const deleted = await deletePeerRow(ctx.beta, row.id);
        if (deleted.status === 200) {
          cleared.push(String(row.id).slice(0, 8));
          ctx.state.createdPeerIds.delete(row.id);
        } else problems.push(`${String(row.id).slice(0, 8)}: ${httpSummary(deleted)}`);
      }
      return problems.length
        ? fail(`beta’s row(s) for core could not be deleted: ${problems.join('; ')}`)
        : pass(`beta’s row(s) for core survived the best-effort HTTPS callback, so the runner deleted them explicitly (${cleared.join(', ')})`);
    },
  },
  {
    id: '10.4',
    title: 'Restore both nodes’ pool settings from the startup snapshot',
    on: 'both',
    wire: `PATCH ${POOL}/settings`,
    tier: 'execute',
    would: 'PATCH each node’s settings back to the values captured before any step ran, then deep-compare',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const restored = [];
      for (const node of [ctx.core, ctx.beta]) {
        const snapshot = ctx.state.settingsSnapshot[node.label];
        if (!snapshot) {
          restored.push(`${node.label}: no snapshot captured — nothing restored`);
          continue;
        }
        const body = {};
        for (const key of SETTINGS_RESTORE_KEYS) {
          if (snapshot[key] !== undefined) body[key] = snapshot[key];
        }
        const res = await call(node, `${POOL}/settings`, { method: 'PATCH', body });
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        const drifted = Object.keys(body).filter((key) => JSON.stringify(res.json?.[key]) !== JSON.stringify(body[key]));
        if (drifted.length) return fail(`${node.label}: ${drifted.join(', ')} did not restore`);
        restored.push(`${node.label}: ${Object.keys(body).length} field(s)`);
      }
      ctx.state.mustRestore.settings.clear();
      ctx.state.mustRestore.betaPoolEnabled = false;
      return pass(restored.join(' | '));
    },
  },
  {
    id: '10.5',
    title: 'Remove any routing pin this run created, and report pin drift',
    on: 'both',
    wire: `GET ${POOL}/settings (poolPins) — plus DELETE ${POOL}/pins only for a pin this run wrote`,
    // No step in this runner calls POST /pins, so `pinsCreated` is empty and nothing is deleted.
    // That matters: a pin is persisted config (hub-pool-pin.service.ts:70, :90-93) and the restore
    // path cannot put one back — `poolPins` is not a field of UpdateHubPoolPreferencesBody
    // (hub-pool.dto.ts:132-171), so zod strips it from any PATCH. Deleting an operator's pin here
    // would be a destructive request this runner cannot reverse, so it does not make it.
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const lines = [];
      const problems = [];
      let inconclusive = false;
      for (const node of [ctx.core, ctx.beta]) {
        const mine = ctx.state.pinsCreated[node.label] ?? [];
        const removed = [];
        for (const pin of mine) {
          if (!ctx.opts.execute) continue;
          const query = pin.scope === 'model' ? `scope=model&model=${encodeURIComponent(pin.model)}` : 'scope=default';
          const res = await call(node, `${POOL}/pins?${query}`, { method: 'DELETE' });
          if (!res.ok) return fail(`${node.label}: could not remove the pin this run created: ${httpSummary(res)}`);
          removed.push(pin.scope);
        }
        if (removed.length) ctx.state.pinsCreated[node.label] = [];
        const res = await getSettings(node);
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        const now = res.json?.poolPins ?? [];
        const before = ctx.state.settingsSnapshot[node.label]?.poolPins;
        const suffix = removed.length ? ` (removed ${removed.length} pin(s) this run created)` : '';
        if (before === undefined) {
          inconclusive = true;
          lines.push(`${node.label}: ${now.length} pin(s), no startup snapshot to compare against${suffix}`);
          continue;
        }
        const expected = before.length - removed.length;
        // A pin that VANISHED is the serious direction: `POST /pins` is the only way to write one
        // back and this runner never calls it, so a lost pin is a config change nobody can undo from
        // here. A pin that APPEARED is reported but not failed — it is not this runner's doing, and
        // the operator may have added it on purpose; it does change the 502 text the 7.x steps match.
        if (now.length < expected) {
          problems.push(
            `${node.label}: ${expected - now.length} routing pin(s) disappeared during the run (${before.length} -> ${now.length}); this runner writes no pins and cannot restore one — re-create it with POST ${POOL}/pins`,
          );
          continue;
        }
        if (JSON.stringify(now) !== JSON.stringify(before) && !removed.length) {
          inconclusive = true;
          lines.push(
            `${node.label}: pins changed during the run (${before.length} -> ${now.length}) — not by this runner; a stray pin changes the 502 text 7.1d/7.4d/7.5c/7.6d match`,
          );
          continue;
        }
        lines.push(`${node.label}: ${now.length} pin(s), unchanged since startup${suffix}`);
      }
      if (problems.length) return fail(problems.join(' | '));
      return inconclusive ? blocked(lines.join(' | ')) : pass(lines.join(' | '));
    },
  },
  {
    id: '10.6',
    title: 'Manual restorations the API cannot perform',
    on: 'both',
    wire: 'env-file edits, container restarts, model deletion — none has an HTTP route',
    tier: 'readonly',
    manualAction:
      'Per node as applicable: remove HUB_POOL_USER_DISABLED / HUB_POOL_OUTBOUND_DISABLED / HUB_POOL_INBOUND_DISABLED and restart; restart any inference engine stopped in section 5; delete <model-beta> if it was pulled only for this run.',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const problems = [];
      for (const node of [ctx.core, ctx.beta]) {
        const res = await getStatus(node);
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        const status = res.json;
        if (status.disabledBy === 'env') problems.push(`${node.label}: HUB_POOL_USER_DISABLED is still set`);
        if (status.directions?.outbound?.disabledBy === 'env') problems.push(`${node.label}: HUB_POOL_OUTBOUND_DISABLED is still set`);
        if (status.directions?.inbound?.disabledBy === 'env') problems.push(`${node.label}: HUB_POOL_INBOUND_DISABLED is still set`);
        if (status.localNode?.capabilitiesError)
          problems.push(
            `${node.label}: capabilitiesError "${status.localNode.capabilitiesError}" — an engine stopped in section 5 was never restarted`,
          );
        else if (!(status.localNode?.backends ?? []).some((backend) => backend.healthy === true)) problems.push(`${node.label}: no healthy backend`);
      }
      // Assert the OUTCOME rather than the action.
      return problems.length ? fail(problems.join('; ')) : pass('no env override in force on either node, and both have a healthy backend');
    },
  },
  {
    id: '10.7',
    title: 'Both nodes are back to the pre-test state',
    on: 'both',
    wire: `GET ${POOL}/status`,
    tier: 'readonly',
    async run(ctx) {
      const stop = gate(poolGate(ctx.core, ctx.beta), tokenGate(ctx.core, ctx.beta));
      if (stop) return stop;
      const problems = [];
      for (const node of [ctx.core, ctx.beta]) {
        const res = await getStatus(node);
        if (!res.ok) return fail(`${node.label}: ${httpSummary(res)}`);
        const status = res.json;
        if (status.enabled !== true || status.disabledBy !== null)
          problems.push(`${node.label}: enabled=${status.enabled} disabledBy=${status.disabledBy}`);
        if ((status.peerCounts?.total ?? 0) !== 0) problems.push(`${node.label}: ${status.peerCounts.total} peer row(s) survived teardown`);
        else if (status.reason !== 'no_peers')
          problems.push(
            `${node.label}: reason='${status.reason}'${status.reason === 'partially_disabled' ? ' — 10.4 did not fully restore the directional switches' : ''}`,
          );
        if (status.routingActive !== false) problems.push(`${node.label}: routingActive=true with no peers`);
        if (status.localNode?.tailscaleConnected !== true) problems.push(`${node.label}: Tailscale not connected`);
      }
      // The routing log is in-memory and process-local, so it is deliberately not asserted here.
      return problems.length
        ? fail(problems.join('; '))
        : pass('both nodes: enabled, 0 peers, reason=no_peers, Tailscale connected — the pre-test state');
    },
  },
];

const ALL_STEPS = [
  ...SECTION_1,
  ...SECTION_2,
  ...SECTION_3,
  ...SECTION_4,
  ...SECTION_5,
  ...SECTION_6,
  ...SECTION_7,
  ...SECTION_8,
  ...SECTION_9,
  ...SECTION_10,
];

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

/** Ask the operator to do something the API cannot, and wait. Only reachable under --interactive. */
async function promptOperator(ctx, message) {
  if (!ctx.opts.interactive) return;
  process.stdout.write(`\n  ACTION REQUIRED: ${message}\n  > `);
  await new Promise((resolve) => {
    const onData = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

/**
 * Does one `--only` token select this step?
 *
 * `2` takes the whole section; `2.8` takes `2.8a`..`2.8f` (the letter-suffixed ids are how this file
 * splits one doc step into its assertions) and `10.3` takes `10.3b`; `2.9d` takes exactly itself.
 * The letter rule is what stops `2.1` from swallowing `2.11`, and `1` from swallowing `10.1`.
 */
function matchesToken(token, id) {
  if (id === token || id.split('.')[0] === token || id.startsWith(`${token}.`)) return true;
  return id.startsWith(token) && /^[a-z]+$/.test(id.slice(token.length));
}

/** `--only 1,2` matches whole sections; `--only 2.8` matches every step whose id starts with it. */
function selects(only, id) {
  if (!only) return true;
  return only.some((token) => matchesToken(token, id));
}

/** `--only` tokens that name no step at all. A typo here is a silently green run, so it is an error. */
const unmatchedOnly = (only, steps) => (only ?? []).filter((token) => !steps.some((step) => matchesToken(token, step.id)));

/** Which flag, if any, is holding this step back. */
function tierGate(step, opts) {
  if (step.tier === 'readonly') return null;
  if (step.tier === 'hazard') {
    if (!opts.execute) return `needs --execute and ${step.flagName}`;
    if (!opts[step.flag]) return `needs ${step.flagName}`;
    return null;
  }
  return opts.execute ? null : 'needs --execute';
}

/** Run every selected step in order, recording one result each. */
async function runSteps(ctx, steps) {
  const results = [];
  for (const step of steps) {
    // Ctrl-C aborts the in-flight request; this is what stops the NEXT one from being issued while
    // teardown is already putting the fleet back.
    if (ctx.state.aborted) break;
    if (!selects(ctx.opts.only, step.id)) continue;
    const held = tierGate(step, ctx.opts);
    if (held) {
      const would = step.would ? ` Would: ${step.would}` : '';
      results.push({ ...summarize(step), verdict: 'SKIP', reason: `${held}.${would}` });
      ctx.report(results[results.length - 1]);
      continue;
    }
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await step.run(ctx);
    } catch (error) {
      outcome = fail(`runner error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!outcome || !VERDICTS.includes(outcome.verdict)) {
      outcome = fail(`step returned no verdict (${JSON.stringify(outcome)})`);
    }
    const result = { ...summarize(step), verdict: outcome.verdict, reason: outcome.reason, durationMs: Date.now() - startedAt };
    results.push(result);
    ctx.report(result);
  }
  return results;
}

/** The static half of a result row. */
const summarize = (step) => ({
  id: step.id,
  title: step.title,
  on: step.on,
  wire: step.wire,
  tier: step.tier,
  manualAction: step.manualAction ?? null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Teardown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Undo whatever this run created, on every exit path — normal, Ctrl-C, or an unhandled error.
 *
 * Held streams first (they hold in-flight counters open), then settings this run changed, then
 * pairing state. Both sides of a pairing are always cleared explicitly: the unpair callback is
 * best-effort and HTTPS-only, so trusting it leaves the far node holding a stale row.
 */
async function teardown(ctx) {
  if (ctx.state.teardownDone) return ctx.state.teardownResult;
  ctx.state.teardownDone = true;
  const actions = [];
  const problems = [];

  const released = await releaseHeldStreams(ctx);
  if (released) actions.push(`released ${released} held stream(s)`);

  if (!ctx.opts.teardown) {
    ctx.state.teardownResult = { attempted: false, actions, problems, note: '--no-teardown: pairing state and settings were left as they are' };
    return ctx.state.teardownResult;
  }

  // Settings first: a node left with pooling disabled is the one way a run can damage the fleet.
  for (const node of [ctx.core, ctx.beta]) {
    if (!node?.token || !node?.hasPool) continue;
    const changed = ctx.state.mustRestore.settings.has(node.label) || (node.label === 'beta' && ctx.state.mustRestore.betaPoolEnabled);
    if (!changed) continue;
    const snapshot = ctx.state.settingsSnapshot[node.label];
    const body = {};
    for (const key of SETTINGS_RESTORE_KEYS) {
      if (snapshot?.[key] !== undefined) body[key] = snapshot[key];
    }
    // Belt and braces. `main` snapshots both nodes before any step runs, so this should not happen —
    // but a run that changed a setting and has nothing to restore from must not slip through as a
    // clean teardown. `poolEnabled: true` is the one value that is knowable without a snapshot: it
    // is the precondition every section of the plan starts from.
    if (Object.keys(body).length === 0) {
      if (ctx.state.mustRestore.betaPoolEnabled && node.label === 'beta') body.poolEnabled = true;
      else {
        problems.push(
          `${node.label} settings were changed but no snapshot was captured — compare GET ${POOL}/settings against the values you expect and reverse by hand`,
        );
        continue;
      }
    }
    const res = await call(node, `${POOL}/settings`, { method: 'PATCH', body });
    const took = res.status === 200 && Object.entries(body).every(([key, value]) => JSON.stringify(res.json?.[key]) === JSON.stringify(value));
    if (took) {
      actions.push(`restored ${node.label}'s pool settings (${Object.keys(body).join(', ')})`);
      ctx.state.mustRestore.settings.delete(node.label);
      if (node.label === 'beta') ctx.state.mustRestore.betaPoolEnabled = false;
    } else {
      problems.push(
        `${node.label} settings NOT restored (${res.status === 200 ? 'the PATCH returned 200 but the values did not take' : httpSummary(res)}) — reverse by hand: PATCH ${POOL}/settings ${JSON.stringify(body)}`,
      );
    }
  }

  // A peer disabled by 7.6b routes nothing, for ever, and no other teardown branch touches it: the
  // row is still `connected`, so an interrupted section 7 leaves core quietly refusing to use beta.
  if (ctx.state.mustRestore.peerEnabled && ctx.state.peerIdOnCore && ctx.core?.token && ctx.core?.hasPool) {
    const id = ctx.state.peerIdOnCore;
    const rows = await getPeers(ctx.core);
    // A row that is already gone (10.2 unpaired it) has nothing left to re-enable — `enabled` dies
    // with the row — so the flag is simply cleared.
    const stillThere = rows.status === 200 && (rows.json ?? []).some((row) => row.id === id);
    ctx.state.mustRestore.peerEnabled = stillThere;
    if (stillThere) {
      const res = await call(ctx.core, `${POOL}/peers/${id}/enable`, { method: 'POST', body: {} });
      if (res.status === 200 && res.json?.enabled === true) {
        actions.push(`re-enabled beta's peer row on core (7.6b had disabled it)`);
        ctx.state.mustRestore.peerEnabled = false;
      } else {
        problems.push(
          `core still has beta's peer row DISABLED (${httpSummary(res)}) — no work will route to beta until it is re-enabled by hand: POST ${POOL}/peers/${id}/enable`,
        );
      }
    }
  }

  // Cancel any PIN this run minted, so nothing is left outstanding on an operator's screen.
  for (const label of ctx.state.pinMintedOn) {
    const node = label === 'core' ? ctx.core : ctx.beta;
    if (!node?.token) continue;
    const res = await call(node, `${POOL}/pairing-pin`, { method: 'DELETE' });
    if (res.status === 200) actions.push(`cancelled the outstanding PIN on ${label}`);
  }

  if (ctx.state.paired) {
    const cleared = await clearBothSides(ctx);
    if (cleared.cleared.length) actions.push(`unpaired ${cleared.cleared.join(', ')}`);
    if (cleared.left.length) actions.push(`left pre-existing peer row(s) with other nodes untouched (${cleared.left.join(', ')})`);
    if (cleared.problems.length) problems.push(...cleared.problems.map((problem) => `unpair: ${problem}`));
    ctx.state.paired = false;
  }

  ctx.state.teardownResult = { attempted: true, actions, problems };
  return ctx.state.teardownResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/** The doc's own Results table, rolled up from the fine-grained step ids. */
const DOC_ROWS = [
  ['1.1', 'Both nodes on the tailnet', ['1.1']],
  ['1.2', 'TLS reachable in both directions', ['1.2a', '1.2b']],
  ['1.3', 'Admin API credential on one node', ['1.3']],
  ['1.4', 'Inventories differ as required', ['1.4a', '1.4b']],
  ['2.1', 'Discovery lists the other node', ['2.1']],
  ['2.2', 'Pairing initiated from core', ['2.2a', '2.2b']],
  ['2.3', 'Approved on beta', ['2.3a', '2.3b']],
  ['2.4', 'Both connected, engines populated', ['2.4']],
  ['2.5', 'Reject clears both sides', ['2.5a', '2.5b', '2.5c', '2.5d']],
  ['2.6', 'Re-pair after unpair', ['2.6a', '2.6b', '2.6c']],
  ['2.7', 'Bearer to signed upgrade', ['2.7a', '2.7b', '2.7c']],
  ['2.8', 'PIN pairing end to end', ['2.8a', '2.8b', '2.8c', '2.8d', '2.8e', '2.8f']],
  ['2.9', 'A wrong PIN creates nothing', ['2.9a', '2.9b', '2.9c', '2.9d', '2.9e']],
  ['2.10', 'A renamed node keeps routing', ['2.10']],
  ['2.11', 'Identity rotation unpairs', ['2.11']],
  ['3.1', 'Beta-only model served by beta', ['3.1.1', '3.1.2', '3.1.3', '3.1.4']],
  ['3.2', 'Shared model stays local when idle', ['3.2.1', '3.2.2', '3.2.3']],
  ['3.3', 'Affinity holds at depth 1', ['3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.5', '3.3.6']],
  ['4.1', 'Deterministic handoff at depth 2', ['4.1.1', '4.1.2', '4.1.3', '4.1.4', '4.1.5', '4.1.6', '4.1.7']],
  ['4.2', 'Burst splits across both nodes', ['4.2.1', '4.2.2']],
  ['5.1', 'Beta engine down, core serves', ['5.1.1', '5.1.2', '5.1.3', '5.1.4', '5.1.5']],
  ['5.2', 'Core engine down, beta serves', ['5.2.1', '5.2.2', '5.2.3', '5.2.4', '5.2.5']],
  ['5.3', 'Mid-stream failure is not corrupted', ['5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.5']],
  ['6.1', 'Three strikes to unreachable', ['6.1.1', '6.1.2', '6.1.3', '6.1.4', '6.1.5']],
  ['6.2', 'Self-recovery within one poll', ['6.2.1', '6.2.2', '6.2.3']],
  ['7.1', 'Kill switch stops routing', ['7.1a', '7.1b', '7.1c', '7.1d']],
  ['7.2', 'Env flag beats the setting', ['7.2a', '7.2b']],
  ['7.3', 'Recovery after removing the flag', ['7.3a', '7.3b', '7.3c', '7.3d']],
  ['7.4', 'Inbound only: beta stops serving', ['7.4a', '7.4b', '7.4c', '7.4d', '7.4e', '7.4f']],
  ['7.5', 'Outbound only: core stops sending', ['7.5a', '7.5b', '7.5c', '7.5d', '7.5e']],
  ['7.6', 'Per-peer switch without unpairing', ['7.6a', '7.6b', '7.6c', '7.6d', '7.6e', '7.6f']],
  ['8.1-8.8', 'Routed endpoints, streaming and not', ['8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '8.7', '8.8', '8.14']],
  ['8.9-8.13', 'Local-only endpoints and the 400', ['8.9', '8.10', '8.11a', '8.11b', '8.12', '8.13']],
  ['9.1', 'Tunnel headers refused', ['9.0', '9.1a', '9.1b', '9.1c']],
  ['9.2', 'Unpaired device refused', ['9.2a', '9.2b', '9.2c', '9.2d']],
  ['10', 'Teardown clean', ['10.1', '10.2', '10.3', '10.3b', '10.4', '10.5', '10.6', '10.7']],
];

/** FAIL dominates; then PASS; then whichever of MANUAL/BLOCKED/SKIP is most informative. */
function rollUp(results, ids) {
  const seen = results.filter((result) => ids.includes(result.id));
  if (seen.length === 0) return { verdict: '—', counts: {} };
  const counts = {};
  for (const result of seen) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  // A row cannot be ticked while anything in it is unresolved, so BLOCKED and MANUAL outrank PASS.
  const verdict = counts.FAIL ? 'FAIL' : counts.BLOCKED ? 'BLOCKED' : counts.MANUAL ? 'MANUAL' : counts.PASS ? 'PASS' : 'SKIP';
  return { verdict, counts };
}

const COLOURS = { PASS: '[32m', FAIL: '[31m', SKIP: '[90m', MANUAL: '[35m', BLOCKED: '[33m' };
const RESET = '[0m';
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (verdict) => (useColour ? `${COLOURS[verdict] ?? ''}${verdict.padEnd(7)}${RESET}` : verdict.padEnd(7));

/** Clip a title to the terminal width so the table stays a table. */
function clip(text, width) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

/** Word-wrap a reason across as many continuation lines as it needs. */
function wrap(text, width) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return [];
  const lines = [];
  let line = '';
  for (const word of flat.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function printHeader(ctx) {
  const line = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`);
  console.log('\nHub Pool two-node QA — docs/hub-pool-fleet-testing.md');
  for (const node of [ctx.core, ctx.beta]) {
    const build = node.hasPool
      ? `Hub Pool protocol ${node.legacyIdentify ? '1 (inferred)' : node.protocol}`
      : node.isHub
        ? 'NO HUB POOL (older build)'
        : node.base
          ? 'answering, but not a CI-Hub API'
          : 'UNREACHABLE';
    const downgrade = node.downgraded ? '  [HTTPS DOWNGRADED to plain HTTP]' : '';
    line(node.label, `${node.input} -> ${node.base ?? 'unreachable'} via ${node.baseForm ?? '-'} · ${build}${downgrade}`);
    if (node.token === null) line('', '  no operator credential — operator routes will report BLOCKED');
  }
  const mode = ctx.opts.execute
    ? `EXECUTE${ctx.opts.wrongPin ? ' +wrong-pin' : ''}${ctx.opts.rotateIdentity ? ' +rotate-identity' : ''}`
    : 'READ-ONLY (default; add --execute for the mutating lifecycle)';
  line('mode', mode);
  if (ctx.opts.only) line('only', ctx.opts.only.join(', '));
  const models = ctx.state.models;
  line(
    'models',
    models.both && models.beta
      ? `<model-both>="${models.both}" <model-beta>="${models.beta}" (${models.source})`
      : `NOT ESTABLISHED — ${models.error ?? 'unknown'}`,
  );
  console.log('');
  console.log(`  ${'ID'.padEnd(7)} ${'VERDICT'.padEnd(7)} STEP`);
  console.log(`  ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(60)}`);
}

function printResult(result) {
  const width = Math.max(48, (process.stdout.columns ?? 120) - 20);
  console.log(`  ${result.id.padEnd(7)} ${paint(result.verdict)} ${clip(result.title, width)}`);
  // Reasons carry the evidence, so they are wrapped rather than clipped — a truncated reason is a
  // result the reader cannot act on.
  for (const line of wrap(result.reason, width)) console.log(`  ${' '.repeat(15)} ${line}`);
}

function printSummary(ctx, results, teardownResult, exitCode) {
  const counts = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;

  console.log('\n  Results (the doc’s own table)\n');
  console.log(`  ${'#'.padEnd(10)} ${'RESULT'.padEnd(7)} CHECK`);
  console.log(`  ${'-'.repeat(10)} ${'-'.repeat(7)} ${'-'.repeat(50)}`);
  for (const [key, label, ids] of DOC_ROWS) {
    const rolled = rollUp(results, ids);
    if (rolled.verdict === '—') continue;
    const detail = Object.entries(rolled.counts)
      .map(([verdict, count]) => `${count} ${verdict.toLowerCase()}`)
      .join(', ');
    console.log(`  ${key.padEnd(10)} ${rolled.verdict === '—' ? '—      ' : paint(rolled.verdict)} ${label}  (${detail})`);
  }

  const manual = results.filter((result) => result.verdict === 'MANUAL' && result.manualAction);
  if (manual.length) {
    console.log('\n  Manual steps left to do\n');
    for (const result of manual) {
      const lines = wrap(result.manualAction, Math.max(48, (process.stdout.columns ?? 120) - 12));
      console.log(`  ${result.id.padEnd(7)} ${lines[0]}`);
      for (const line of lines.slice(1)) console.log(`  ${' '.repeat(7)} ${line}`);
    }
  }

  if (ctx.state.notes.length) {
    console.log('\n  Runner notes\n');
    for (const note of ctx.state.notes) console.log(`  · ${note}`);
  }

  console.log('\n  Teardown');
  if (!teardownResult.attempted) console.log(`  · ${teardownResult.note}`);
  else if (teardownResult.actions.length === 0 && teardownResult.problems.length === 0)
    console.log('  · nothing to undo — this run created no pairing state or settings changes');
  else {
    for (const action of teardownResult.actions) console.log(`  · ${action}`);
    for (const problem of teardownResult.problems) console.log(`  ! ${problem}`);
  }
  console.log(`  ${teardownResult.problems.length === 0 ? 'teardown succeeded' : 'TEARDOWN INCOMPLETE — see the lines above'}`);

  const tally = VERDICTS.filter((verdict) => counts[verdict])
    .map((verdict) => `${counts[verdict]} ${verdict.toLowerCase()}`)
    .join(', ');
  console.log(`\n  ${results.length} step(s): ${tally || 'none run'}`);
  const why = [
    counts.FAIL ? `${counts.FAIL} step(s) FAILED` : null,
    teardownResult.problems.length
      ? `teardown left ${teardownResult.problems.length} problem(s) — the fleet is NOT back to its pre-test state`
      : null,
    results.length === 0 ? 'no step ran' : null,
  ].filter(Boolean);
  console.log(
    exitCode === 0
      ? '  exit 0 — no step failed and teardown was clean (SKIP/MANUAL/BLOCKED do not fail the run)\n'
      : `  exit ${exitCode} — ${why.join('; ')}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pool-qa: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.core || !opts.beta) {
    console.error('pool-qa: --core and --beta are both required\n');
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  // An unmatched `--only` token runs nothing and would otherwise report a green run — the same
  // reasoning that makes an unknown flag an error. `--only 2.9d` vs `--only 2.9.d` must not be silent.
  if (opts.only) {
    const unmatched = unmatchedOnly(opts.only, ALL_STEPS);
    if (unmatched.length || opts.only.length === 0) {
      const complaint = unmatched.length ? `--only matched no step: ${unmatched.join(', ')}` : '--only was given no step ids';
      console.error(`pool-qa: ${complaint}\n`);
      console.error(`Valid ids: ${ALL_STEPS.map((step) => step.id).join(', ')}`);
      console.error('A section number (2), a doc step (2.8, which takes 2.8a-2.8f) or one id (2.9d) all work.\n');
      process.exitCode = 2;
      return;
    }
  }

  const [core, beta] = await Promise.all([resolveNode('core', opts.core, opts.coreToken), resolveNode('beta', opts.beta, opts.betaToken)]);

  const ctx = {
    opts,
    core,
    beta,
    state: {
      status: {},
      models: { both: null, beta: null, source: 'unset' },
      settingsSnapshot: {},
      watermark: {},
      marks: {},
      expected: {},
      heldStreams: [],
      pinMintedOn: new Set(),
      pinsCreated: { core: [], beta: [] },
      mustRestore: { settings: new Set(), betaPoolEnabled: false, peerEnabled: false },
      notes: [],
      paired: false,
      aborted: false,
      peerIdOnCore: null,
      peerIdOnBeta: null,
      createdPeerIds: new Set(),
      preexistingPeerIds: { core: new Set(), beta: new Set() },
      pollSeconds: DEFAULT_POLL_SECONDS,
      mutationsDuringRecovery: 0,
    },
    report: opts.json ? () => undefined : printResult,
  };

  // Establish the model placeholders before any step needs them, from /status where a credential
  // exists and from the app-facing inventory where one does not.
  await bootstrapModels(ctx);
  // Then the baseline teardown restores from. Taken here, not in a step: 6.1.2 disables pooling on
  // beta, and an interrupt anywhere before section 7 must still be reversible.
  await captureBaseline(ctx);

  let finished = false;
  const bail = async (signal) => {
    if (finished) return;
    finished = true;
    ctx.state.aborted = true;
    // Cancel the step's in-flight request, then take the run signal away so teardown's own calls —
    // the ones that put the fleet back — are issued without it. Without this, an interrupted
    // `POST /peers/pair` could land AFTER teardown has already read and emptied /peers.
    const cancel = runAbort;
    runAbort = null;
    cancel?.abort(new Error(`${signal}: run cancelled`));
    if (!opts.json) console.log(`\n  ${signal} — cancelling the running step, then tearing down before exit`);
    const result = await teardown(ctx);
    if (!opts.json) {
      for (const action of result.actions) console.log(`  · ${action}`);
      for (const problem of result.problems) console.log(`  ! ${problem}`);
      console.log(`  ${result.problems.length === 0 ? 'teardown succeeded' : 'TEARDOWN INCOMPLETE — see the lines above'}`);
    }
    process.exit(130);
  };
  process.once('SIGINT', () => void bail('SIGINT'));
  process.once('SIGTERM', () => void bail('SIGTERM'));

  if (!opts.json) printHeader(ctx);

  let results = [];
  let runError = null;
  runAbort = new AbortController();
  try {
    results = await runSteps(ctx, ALL_STEPS);
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }
  finished = true;
  // Teardown's calls are never cancelled by the run signal.
  runAbort = null;
  const teardownResult = await teardown(ctx);

  // A fleet left dirty is exactly the condition a CI caller must not read as success.
  const exitCode =
    results.some((result) => result.verdict === 'FAIL') || runError || teardownResult.problems.length ? 1 : results.length === 0 ? 2 : 0;

  if (opts.json) {
    const counts = { teardownProblems: teardownResult.problems.length };
    for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          options: { execute: opts.execute, wrongPin: opts.wrongPin, rotateIdentity: opts.rotateIdentity, only: opts.only, teardown: opts.teardown },
          nodes: [core, beta].map((node) => ({
            label: node.label,
            input: node.input,
            base: node.base,
            baseForm: node.baseForm,
            downgraded: node.downgraded,
            hasPool: node.hasPool,
            isHub: node.isHub,
            poolProtocol: node.protocol,
            legacyIdentify: node.legacyIdentify,
            nodeFqdn: node.fqdn,
            httpsFqdnReachable: node.httpsFqdn,
            hasOperatorToken: Boolean(node.token),
            attempts: node.attempts.map(({ base, form, reachable, hasPool, isHub, status, error }) => ({
              base,
              form,
              reachable,
              hasPool,
              isHub,
              status,
              error,
            })),
          })),
          models: ctx.state.models,
          steps: results,
          docResults: DOC_ROWS.map(([key, label, ids]) => ({ key, label, ...rollUp(results, ids) })).filter((row) => row.verdict !== '—'),
          manual: results
            .filter((result) => result.verdict === 'MANUAL' && result.manualAction)
            .map(({ id, manualAction }) => ({ id, action: manualAction })),
          notes: ctx.state.notes,
          teardown: teardownResult,
          counts,
          runError,
        },
        null,
        2,
      ),
    );
  } else {
    if (runError) console.log(`\n  runner error: ${runError}`);
    printSummary(ctx, results, teardownResult, exitCode);
  }

  process.exitCode = exitCode;
}

/**
 * Establish `<model-both>` / `<model-beta>` up front.
 *
 * `/status` is authoritative — it distinguishes "no models" from "engine down" via
 * `capabilitiesError`, which `/api/tags` cannot — but the app-facing inventory needs no credential,
 * so it is the fallback when the runner holds no operator key for a node.
 */
async function bootstrapModels(ctx) {
  const envBoth = process.env.POOL_QA_MODEL_BOTH?.trim();
  const envBeta = process.env.POOL_QA_MODEL_BETA?.trim();
  if (envBoth && envBeta) {
    ctx.state.models = { both: envBoth, beta: envBeta, source: 'env' };
    return;
  }
  const inventories = {};
  for (const node of [ctx.core, ctx.beta]) {
    if (!node.hasPool) {
      inventories[node.label] = new Set();
      continue;
    }
    if (node.token) {
      const res = await getStatus(node);
      if (res.status === 200) {
        inventories[node.label] = modelsOf(res.json.localNode?.backends);
        ctx.state.status[node.label] = res.json;
        node.fqdn = res.json.localNode?.nodeFqdn ?? node.fqdn;
        continue;
      }
    }
    const tags = await call(node, `${POOL}/api/tags`, { auth: 'none' });
    inventories[node.label] = new Set(
      tags.status === 200 && Array.isArray(tags.json?.models) ? tags.json.models.map((model) => model.name).filter(Boolean) : [],
    );
  }
  await establishModels(ctx, inventories.core ?? new Set(), inventories.beta ?? new Set(), 'the reachable inventories');
}

/**
 * Snapshot what teardown will have to put back, BEFORE any step runs.
 *
 * Two things, for two different reasons.
 *
 * `GET /settings` is the source of truth for the restore. It used to be captured by step 7.0b, which
 * meant a run that stopped in section 6 — where 6.1.2 PATCHes `{poolEnabled:false}` on beta — had
 * nothing to restore from and silently reported a clean teardown while beta sat with pooling off.
 * Every mutating step comes after this call, so the snapshot always exists.
 *
 * `GET /peers` records the pairings that were already there. Those with a third node are ones this
 * runner did not create and cannot recreate — re-pairing needs a PIN minted on that node's screen —
 * so nothing may delete them; `partitionPeerRows` is what enforces it, and this is the evidence.
 */
async function captureBaseline(ctx) {
  for (const node of [ctx.core, ctx.beta]) {
    if (!node.hasPool || !node.token) continue;
    const settings = await getSettings(node);
    if (settings.status === 200) ctx.state.settingsSnapshot[node.label] = settings.json;
    const peers = await getPeers(node);
    if (!peers.ok) continue;
    const rows = peers.json ?? [];
    ctx.state.preexistingPeerIds[node.label] = new Set(rows.map((row) => row.id));
    const counterpartFqdn = node.label === 'core' ? ctx.beta.fqdn : ctx.core.fqdn;
    const foreign = rows.filter((row) => !counterpartFqdn || row.nodeFqdn !== counterpartFqdn);
    if (foreign.length) {
      ctx.state.notes.push(
        `${node.label} was already paired with ${foreign.length} other node(s) before this run (${foreign.map((row) => row.nodeFqdn).join(', ')}) — those rows are never deleted by this runner`,
      );
    }
  }
}

await main();
