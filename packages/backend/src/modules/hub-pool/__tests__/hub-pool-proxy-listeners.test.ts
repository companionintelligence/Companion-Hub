/**
 * One pool request, one `close` listener on its response — however many candidates it walks.
 *
 * core-2, 2026-09-29: `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11
 * close listeners added to [ServerResponse]`, about once per pool request, 1,011 times in one hour.
 * Measured here before the fix: nothing grew with the walk — twelve failed candidates added no
 * listener to the response — but a relayed response carried eight of the proxy's own `close`
 * listeners mid-stream (one for its client-closed signal, seven from `pipeline`), and the Sentry HTTP
 * integration adds three to every server response (`record-request-session`, `server-subscription`,
 * `httpServerSpansIntegration`). Eleven is one past Node's default limit, on every request.
 *
 * Real sockets, because what is under test is what reaches a real `ServerResponse`, and real `fetch`
 * for the forwards, because undici is what holds the upstream signal. Peers' HTTPS URLs are
 * rewritten to the local fake engine.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { OmlxBackend } from '@/modules/inference/backends/omlx.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { watchResponseClose } from '@/modules/inference/upstream-stream';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  DEFAULT_POOL_SLOT_AWARENESS,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';

const MODEL = 'qwen3.8:27b';
const PEERS = 10;
/** Every candidate before this one answers 503, so the request walks this many and is served by the next. */
const FAILING_CANDIDATES = 12;
/** What the process's HTTP instrumentation hangs on every server response, measured in `@sentry/core` 10.56. */
const INSTRUMENTATION_CLOSE_LISTENERS = 3;

function frame(content: string, done = false): string {
  return `${JSON.stringify({ model: MODEL, message: { role: 'assistant', content }, done })}\n`;
}

describe('a pool request adds one close listener to its response, however many candidates it walks', () => {
  const realFetch = globalThis.fetch;
  const closers: Array<() => void> = [];
  let engineRequests = 0;
  /** Filled in by the engine while the served stream is paused mid-generation. */
  let midStream: (() => void) | null = null;
  let enginePort = 0;

  beforeEach(async () => {
    engineRequests = 0;
    const engine = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      engineRequests += 1;
      if (engineRequests <= FAILING_CANDIDATES) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"error":"busy"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(frame('Hel'));
      // Held open mid-generation long enough to count what the proxy's response carries.
      setTimeout(() => {
        midStream?.();
        res.end(`${frame('lo')}${frame('', true)}`);
      }, 100);
    });
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
    enginePort = (engine.address() as AddressInfo).port;
    closers.push(() => {
      engine.closeAllConnections();
      engine.close();
    });
    globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
      realFetch(String(url).replace(/^https:\/\/[^/]+\/api\/inference\/pool\/local/, `http://127.0.0.1:${enginePort}`), init)) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const close of closers.splice(0)) close();
    midStream = null;
  });

  function buildService(): PoolProxyService {
    const backends = [mock<OllamaBackend>(), mock<VllmBackend>(), mock<LemonadeBackend>(), mock<OmlxBackend>()];
    for (const backend of backends) {
      backend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      backend.getBaseUrl.mockReturnValue(`http://127.0.0.1:${enginePort}`);
    }
    const peers = Array.from({ length: PEERS }, (_, index) => ({
      id: `peer-${index}`,
      nodeFqdn: `core-${index}.tailxyz.ts.net`,
      status: 'connected',
      enabled: true,
      lastSeenAt: new Date().toISOString(),
      lastCapabilities: {
        hardwareTier: 'high',
        backends: [{ type: 'ollama', healthy: true, modelsLoaded: [MODEL] }],
        inFlightRequests: 0,
        updatedAt: new Date().toISOString(),
      },
    })) as unknown as HubPoolPeer[];
    const configuration = mock<ConfigurationService>();
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolPins: [],
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      poolMaxPromptTokens: null,
      poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      poolPrefixAffinityMaxInFlight: DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
      poolSlotAwareness: DEFAULT_POOL_SLOT_AWARENESS,
    } as unknown as HubPoolPreferences);
    const peerService = mock<HubPoolPeerService>();
    peerService.listConnectedPeers.mockResolvedValue(peers);
    peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
    peerService.peerAuthHeaders.mockResolvedValue({});
    const pressureService = mock<HubPoolPressureService>();
    pressureService.band.mockReturnValue(null);
    return new PoolProxyService(
      new InferenceBackendRegistry(...(backends as unknown as [OllamaBackend, VllmBackend, LemonadeBackend, OmlxBackend])),
      peerService,
      mock<TailscaleService>(),
      new HubPoolLoadService(),
      configuration,
      new HubPoolRoutingLogService(),
      pressureService,
    );
  }

  it(`walks ${FAILING_CANDIDATES} failing candidates with one listener of its own, and no MaxListenersExceededWarning`, async () => {
    const service = buildService();
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    closers.push(() => process.off('warning', onWarning));

    const counts: { atStart: number; midStream: number; settled: number } = { atStart: -1, midStream: -1, settled: -1 };
    let settled!: Promise<void>;
    const app = express();
    app.post('/proxy', express.json(), (req, res) => {
      // What the HTTP instrumentation adds before any route runs.
      for (let i = 0; i < INSTRUMENTATION_CLOSE_LISTENERS; i += 1) res.on('close', () => undefined);
      counts.atStart = res.listenerCount('close');
      midStream = () => {
        counts.midStream = res.listenerCount('close');
      };
      settled = service.proxyRequest({ path: '/api/chat', method: 'POST', body: req.body, model: MODEL, res }).then(() => {
        counts.settled = res.listenerCount('close');
      });
    });
    const front: Server = createServer(app);
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    closers.push(() => {
      front.closeAllConnections();
      front.close();
    });

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${(front.address() as AddressInfo).port}/proxy`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve(text));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
    await settled;
    // A warning is emitted on the next tick after the listener that crosses the limit.
    await new Promise((resolve) => setImmediate(resolve));

    expect(engineRequests).toBe(FAILING_CANDIDATES + 1);
    expect(body).toBe(`${frame('Hel')}${frame('lo')}${frame('', true)}`);
    expect(counts.atStart).toBe(INSTRUMENTATION_CLOSE_LISTENERS);
    // The proxy's own, mid-stream: one. It was eight.
    expect(counts.midStream - counts.atStart).toBeLessThanOrEqual(1);
    // And gone once the request settled.
    expect(counts.settled).toBe(INSTRUMENTATION_CLOSE_LISTENERS);
    expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual([]);
  });
});

describe('watchResponseClose', () => {
  it('shares one listener between every caller watching the same response, and takes it off on dispose', async () => {
    const server = createServer((_req, res) => {
      const first = watchResponseClose(res);
      const second = watchResponseClose(res);
      const count = res.listenerCount('close');
      first.dispose();
      res.end(JSON.stringify({ same: first === second, count, afterDispose: res.listenerCount('close') }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(await response.json()).toEqual({ same: true, count: 1, afterDispose: 0 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
