import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A Hub under inference load is not an absent Hub.
 *
 * On 2026-09-20 `fleet status` printed `—` in the HUB and PORTAL columns for beta-1, beta-nas,
 * core-5 and core-6. All four were serving a Hub; each answered `/api/registration/phase` with
 * `registered: true` seconds later. `/api/inference/health` health-checks every backend with its own
 * 5 s timeout, so under load it outran the 4 s probe budget, and a probe that timed out was written
 * down the same way as a port with nothing listening. These tests pin the difference.
 */

const SUMMARY_DELAY_MS = 400;
const PHASE_DOC = { phase: 'locally_ready', registered: true, lastCheckIn: { httpStatus: 200, error: null } };
const SUMMARY_DOC = { status: 'ok', hardwareTier: 'high', backends: [{}, {}, {}, {}, {}, {}] };

let server: Server;
let port: number;
/** Mutable per test: which routes hang forever, which are slow, which fail. */
const behaviour = { hang: new Set<string>(), fail: new Set<string>(), slowSummary: false };

function listen(s: Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '';
    if (behaviour.hang.has(path)) return; // never answers — the socket stays open until the client gives up
    if (behaviour.fail.has(path)) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ statusCode: 500 }));
      return;
    }
    const reply = (doc: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
    if (path === '/api/registration/phase') return reply(PHASE_DOC);
    if (path === '/api/inference/health') {
      if (behaviour.slowSummary) setTimeout(() => reply(SUMMARY_DOC), SUMMARY_DELAY_MS);
      else reply(SUMMARY_DOC);
      return;
    }
    if (path === '/text') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
    res.writeHead(404).end();
  });
  port = await listen(server);
  // Read at import, so it has to be set before the module loads. Each vitest file gets its own
  // module graph, so this does not leak into other suites.
  process.env.CI_HUB_API_PORT = String(port);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.CI_HUB_API_PORT;
});

const discover = () => import('../lib/fleet-discover.js');

describe('fetchJson says how a GET failed', () => {
  it('ok, error, refused and timeout are four different answers', async () => {
    const { fetchJson } = await discover();
    behaviour.hang.add('/hang');
    behaviour.fail.add('/fail');
    const base = `http://127.0.0.1:${port}`;

    await expect(fetchJson(`${base}/api/registration/phase`, 1_000)).resolves.toEqual({ kind: 'ok', body: PHASE_DOC });
    await expect(fetchJson(`${base}/fail`, 1_000)).resolves.toEqual({ kind: 'error', detail: 'HTTP 500' });
    await expect(fetchJson(`${base}/missing`, 1_000)).resolves.toEqual({ kind: 'error', detail: 'HTTP 404' });
    await expect(fetchJson(`${base}/text`, 1_000)).resolves.toMatchObject({ kind: 'error' });
    await expect(fetchJson(`${base}/hang`, 150)).resolves.toEqual({ kind: 'timeout' });

    // A port nobody listens on: the one outcome that is allowed to mean "no Hub".
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(fetchJson(`http://127.0.0.1:${closedPort}/api/registration/phase`, 1_000)).resolves.toEqual({ kind: 'refused' });
  });
});

describe('classifyHubProbe: the two routes read as one axis', () => {
  const ok = (body: unknown) => ({ kind: 'ok' as const, body });
  const timeout = { kind: 'timeout' as const };
  const refused = { kind: 'refused' as const };
  const error = { kind: 'error' as const, detail: 'HTTP 500' };

  it('both answered: ok, with the tier and backend count and Portal standing', async () => {
    const { classifyHubProbe } = await discover();
    expect(classifyHubProbe(ok(SUMMARY_DOC), ok(PHASE_DOC))).toEqual({
      hub: true,
      hubProbe: 'ok',
      hubDetail: 'tier high, 6 backends',
      portal: { phase: 'locally_ready', registered: true, checkIn: 200, error: undefined },
    });
  });

  it('phase answered but the summary ran out of budget: a Hub, marked slow, Portal standing intact', async () => {
    const { classifyHubProbe } = await discover();
    const axis = classifyHubProbe(timeout, ok(PHASE_DOC));
    expect(axis).toMatchObject({ hub: true, hubProbe: 'slow' });
    expect(axis.hubDetail).toBeUndefined();
    expect(axis.portal).toMatchObject({ registered: true, checkIn: 200 });
  });

  it('phase answered but the summary errored: a Hub whose health route is broken, not a missing one', async () => {
    const { classifyHubProbe } = await discover();
    expect(classifyHubProbe(error, ok(PHASE_DOC))).toMatchObject({ hub: true, hubProbe: 'error' });
  });

  it('silence on either route is a timeout, never "no Hub"', async () => {
    const { classifyHubProbe } = await discover();
    expect(classifyHubProbe(timeout, timeout)).toEqual({ hub: false, hubProbe: 'timeout' });
    expect(classifyHubProbe(refused, timeout)).toEqual({ hub: false, hubProbe: 'timeout' });
    expect(classifyHubProbe(timeout, refused)).toEqual({ hub: false, hubProbe: 'timeout' });
  });

  it('only a refused connection on both routes is "no Hub"', async () => {
    const { classifyHubProbe } = await discover();
    expect(classifyHubProbe(refused, refused)).toEqual({ hub: false, hubProbe: 'refused' });
    expect(classifyHubProbe(error, refused)).toEqual({ hub: false, hubProbe: 'error' });
    expect(classifyHubProbe(error, error)).toEqual({ hub: false, hubProbe: 'error' });
  });
});

describe('the HUB cell', () => {
  it('keeps — for a port with no listener and names every other outcome', async () => {
    const { renderHubCell } = await discover();
    expect(renderHubCell({ hub: true, hubProbe: 'ok', hubDetail: 'tier high, 6 backends' })).toEqual({ text: 'tier high, 6 backends' });
    expect(renderHubCell({ hub: true, hubProbe: 'ok' })).toEqual({ text: 'yes' });
    expect(renderHubCell({ hub: true, hubProbe: 'slow' })).toEqual({ text: 'yes, slow', tone: 'yellow' });
    expect(renderHubCell({ hub: false, hubProbe: 'timeout' })).toEqual({ text: 'timeout', tone: 'yellow' });
    expect(renderHubCell({ hub: false, hubProbe: 'error' })).toEqual({ text: 'error', tone: 'yellow' });
    expect(renderHubCell({ hub: false, hubProbe: 'refused' })).toEqual({ text: '—', tone: 'dim' });
  });

  it('the scan verdict does not nominate a node for install on the strength of a timeout', async () => {
    const { summariseNode } = await discover();
    const base = { name: 'core-5', ip: '127.0.0.1', source: 'roster' as const, sshFailure: 'ok' as const };
    const timedOut = {
      ...base,
      probe: { ssh: true, sshFailure: 'ok' as const, hub: false, hubProbe: 'timeout' as const, engines: ['ollama:11434'] },
    };
    const refused = { ...base, probe: { ...timedOut.probe, hubProbe: 'refused' as const } };
    const slow = {
      ...base,
      probe: { ...timedOut.probe, hub: true, hubProbe: 'slow' as const, portal: { phase: 'locally_ready', registered: true, checkIn: 200 } },
    };
    expect(summariseNode(timedOut)).toMatch(/Hub probe timed out/);
    expect(summariseNode(timedOut)).not.toMatch(/candidate for install/);
    expect(summariseNode(refused)).toMatch(/candidate for install/);
    expect(summariseNode(slow)).toBe('Hub reachable and administrable');
  });
});

describe('probeNode against a Hub', () => {
  it('gives the backend summary more than the caller’s budget, because that route is the slow one', async () => {
    const { probeNode, HUB_SUMMARY_TIMEOUT_FLOOR_MS } = await discover();
    expect(HUB_SUMMARY_TIMEOUT_FLOOR_MS).toBeGreaterThan(SUMMARY_DELAY_MS);
    behaviour.slowSummary = true;
    try {
      // 150 ms would have cut the 400 ms summary off and, before this file existed, printed `—`.
      const probe = await probeNode({ name: 'core-5', ip: '127.0.0.1' }, { timeoutMs: 150, skipSsh: true });
      expect(probe).toMatchObject({ hub: true, hubProbe: 'ok', hubDetail: 'tier high, 6 backends' });
      expect(probe.portal).toMatchObject({ registered: true, checkIn: 200 });
    } finally {
      behaviour.slowSummary = false;
    }
  });

  it('a summary that never comes leaves a slow Hub, not a missing one, and Portal standing is still read', async () => {
    // The floor is 10 s on purpose; drive the outcome through the classifier the probe uses rather
    // than waiting it out here.
    const { classifyHubProbe, renderHubCell } = await discover();
    const axis = classifyHubProbe({ kind: 'timeout' }, { kind: 'ok', body: PHASE_DOC });
    expect(renderHubCell(axis)).toEqual({ text: 'yes, slow', tone: 'yellow' });
  });

  it('a closed port is the one case that reads —', async () => {
    const { renderHubCell } = await discover();
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    // HUB_API_PORT is read once at import, so the module is reloaded pointing at the closed port.
    process.env.CI_HUB_API_PORT = String(closedPort);
    vi.resetModules();
    const fresh = await discover();
    process.env.CI_HUB_API_PORT = String(port);
    vi.resetModules();
    const probe = await fresh.probeNode({ name: 'core-6', ip: '127.0.0.1' }, { timeoutMs: 500, skipSsh: true });
    expect(probe).toMatchObject({ hub: false, hubProbe: 'refused' });
    expect(renderHubCell(probe)).toEqual({ text: '—', tone: 'dim' });
  });
});
