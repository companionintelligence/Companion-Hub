/**
 * A client that hangs up must stop the engine, not just the proxy.
 *
 * Before this, the proxy's upstream `fetch` carried only its own deadline signal. An app that gave
 * up on a turn — OpenClaw's watchdog, a user pressing stop, a CLI killed with ^C — closed its socket
 * to the Hub, and nothing told the engine: it kept prefilling a prompt nobody would read. On this
 * fleet that is not a small leak. A 47k-token OpenClaw turn takes ~300 s to its first byte on a GPU
 * node (fleet-pool-throughput, 2026-09-16), and the engine serves one sequence at a time, so an
 * abandoned turn holds the node for the full five minutes while every retry queues behind it.
 *
 * These tests use real sockets on both sides — a fake engine that records when its connection
 * closes, and a real Express front end whose client disconnects — because the whole bug is about
 * what reaches a socket. A mocked `fetch` cannot observe an abort that was never sent.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { DsparkBackend } from '@/modules/inference/backends/dspark.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { LuceboxBackend } from '@/modules/inference/backends/lucebox.backend';
import { MtplxBackend } from '@/modules/inference/backends/mtplx.backend';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  DEFAULT_POOL_SLOT_AWARENESS,
} from '@/common/helpers/hub-pool';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';

const MODEL = 'qwen3.6:27b';
/** Long enough that a close which was never propagated cannot pass by accident, short enough for CI. */
const CLOSE_WITHIN_MS = 3_000;

/** A stand-in engine that records every request it is sent and when that request's connection closes. */
interface FakeEngine {
  url: string;
  /** Resolves with each request as it arrives, in order. */
  requests: IncomingMessage[];
  nextRequest(): Promise<{ req: IncomingMessage; res: ServerResponse }>;
  server: Server;
}

async function startEngine(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakeEngine> {
  const requests: IncomingMessage[] = [];
  const waiters: Array<(pair: { req: IncomingMessage; res: ServerResponse }) => void> = [];
  const backlog: Array<{ req: IncomingMessage; res: ServerResponse }> = [];
  const server = createServer((req, res) => {
    requests.push(req);
    // Drain the body so the proxy's upload completes and the only thing left open is the wait.
    req.resume();
    handler(req, res);
    const pair = { req, res };
    const waiter = waiters.shift();
    if (waiter) waiter(pair);
    else backlog.push(pair);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    server,
    nextRequest: () => {
      const queued = backlog.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Resolves when the engine's side of the connection closes; rejects if it is still open after `ms`. */
function closedWithin(res: ServerResponse, ms: number): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    if (res.socket?.destroyed) {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`engine connection still open after ${ms}ms — the client's hang-up never reached it`)), ms);
    res.on('close', () => {
      clearTimeout(timer);
      resolve(Date.now() - startedAt);
    });
  });
}

describe('client disconnects propagate to the engine', () => {
  let ollama: MockProxy<OllamaBackend>;
  let vllm: MockProxy<VllmBackend>;
  let loadService: HubPoolLoadService;
  let routingLog: HubPoolRoutingLogService;
  let service: PoolProxyService;
  let engine: FakeEngine;
  let front: Server;
  let frontUrl: string;
  const cleanups: Array<() => void> = [];

  async function startFront(route: (req: express.Request, res: express.Response) => Promise<void>): Promise<void> {
    const app = express();
    app.post('/proxy', express.json({ limit: '10mb' }), (req, res) => {
      void route(req, res);
    });
    front = createServer(app);
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    frontUrl = `http://127.0.0.1:${(front.address() as AddressInfo).port}/proxy`;
    cleanups.push(() => {
      front.closeAllConnections();
      front.close();
    });
  }

  /** Sends `body` through the front end and returns the client request, so the test can hang up on it. */
  function sendThroughFront(body: unknown, onResponse?: (res: IncomingMessage) => void) {
    const payload = JSON.stringify(body);
    const clientReq = httpRequest(frontUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => onResponse?.(res));
    // A destroyed client request emits 'error' (ECONNRESET/socket hang up); that is the point of the test.
    clientReq.on('error', () => {});
    clientReq.end(payload);
    return clientReq;
  }

  beforeEach(async () => {
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    const others = [mock<LemonadeBackend>(), mock<MtplxBackend>(), mock<DsparkBackend>(), mock<LuceboxBackend>()];
    for (const backend of others) {
      backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    }
    const configuration = mock<ConfigurationService>();
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolPins: [],
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      poolPrefixAffinityMaxInFlight: DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
      poolSlotAwareness: DEFAULT_POOL_SLOT_AWARENESS,
    });
    const peerService = mock<HubPoolPeerService>();
    peerService.listConnectedPeers.mockResolvedValue([]);
    const pressureService = mock<HubPoolPressureService>();
    pressureService.band.mockReturnValue(null);
    loadService = new HubPoolLoadService();
    routingLog = new HubPoolRoutingLogService();
    service = new PoolProxyService(
      new InferenceBackendRegistry(ollama, vllm, ...(others as [LemonadeBackend, MtplxBackend, DsparkBackend, LuceboxBackend])),
      peerService,
      mock<TailscaleService>(),
      loadService,
      configuration,
      routingLog,
      pressureService,
    );
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    engine?.server.closeAllConnections();
    engine?.server.close();
  });

  /** Both local backends list the model and point at the same engine, so a failover would show up as a second request. */
  function serveModelFrom(engineUrl: string): void {
    for (const backend of [ollama, vllm]) {
      backend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      backend.getBaseUrl.mockReturnValue(engineUrl);
    }
  }

  it('aborts the engine request when the client hangs up before response headers, and does not re-place the turn on the next candidate', async () => {
    // An engine still prefilling: it has the request and says nothing yet.
    engine = await startEngine(() => {});
    serveModelFrom(engine.url);
    let settled!: Promise<void>;
    await startFront(async (req, res) => {
      settled = service.proxyRequest({ path: '/api/chat', method: 'POST', body: req.body, model: MODEL, res });
      await settled;
    });

    const client = sendThroughFront({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'a long agent turn' }] });
    const { res: engineRes } = await engine.nextRequest();
    client.destroy();

    await closedWithin(engineRes, CLOSE_WITHIN_MS);
    await settled;
    // One request, not two: the second backend also lists the model, and a client that has left
    // must not cost a second engine a turn nobody will read.
    expect(engine.requests).toHaveLength(1);
    expect(loadService.localInFlight()).toBe(0);
    expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', status: null, failedOverFrom: [] });
  });

  it('aborts the engine stream when the client hangs up mid-generation', async () => {
    // This half already worked before the fix — the pipeline tears down its source, and cancelling
    // the usage tap's stream cancels undici's body — and it is pinned here because the fix moved the
    // signal `fetch` holds for the body, which is exactly what could have broken it.
    // A streaming engine that would generate forever: one frame now, then one every 50 ms.
    engine = await startEngine((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ model: MODEL, message: { content: 'tok' }, done: false })}\n`);
      const tick = setInterval(() => res.write(`${JSON.stringify({ model: MODEL, message: { content: 'tok' }, done: false })}\n`), 50);
      res.on('close', () => clearInterval(tick));
    });
    serveModelFrom(engine.url);
    let settled!: Promise<void>;
    await startFront(async (req, res) => {
      settled = service.proxyRequest({ path: '/api/chat', method: 'POST', body: req.body, model: MODEL, res });
      await settled;
    });

    let firstFrame!: () => void;
    const gotFirstFrame = new Promise<void>((resolve) => (firstFrame = resolve));
    const client = sendThroughFront({ model: MODEL, stream: true, messages: [] }, (res) => res.once('data', () => firstFrame()));
    const { res: engineRes } = await engine.nextRequest();
    await gotFirstFrame;
    client.destroy();

    await closedWithin(engineRes, CLOSE_WITHIN_MS);
    await settled;
    expect(engine.requests).toHaveLength(1);
    expect(loadService.localInFlight()).toBe(0);
  });

  it('aborts the local engine when the PEER that forwarded the work hangs up — the far side of a pool hop', async () => {
    // The sending node aborting its own fetch is only half the fix: this node's engine is the one
    // doing the prefill, and it hears nothing unless the inbound forward propagates the close too.
    engine = await startEngine(() => {});
    serveModelFrom(engine.url);
    let settled!: Promise<unknown>;
    await startFront(async (req, res) => {
      settled = service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', req.body, res, 'sender.tailxyz.ts.net', MODEL).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await settled;
    });

    const client = sendThroughFront({ model: MODEL, stream: true, messages: [] });
    const { res: engineRes } = await engine.nextRequest();
    client.destroy();

    await closedWithin(engineRes, CLOSE_WITHIN_MS);
    // Quietly: nobody is left to answer, so a rethrow would only be Nest logging a routine hang-up as a 500.
    expect(await settled).toBe('resolved');
    expect(loadService.localInFlight()).toBe(0);
  });

  describe('an engine that dies mid-stream is still an engine failure, not a hang-up', () => {
    // `pipeline` destroys the response with the engine's error when its source fails, and that closes
    // the response unfinished exactly as a leaving client does. Reading the two alike hid every engine
    // crash mid-generation behind a debug line claiming the client had gone.

    /** An engine that sends headers and one frame, then drops the connection — a crashed runner, an OOM kill. */
    function engineThatDiesAfterOneFrame() {
      return startEngine((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ model: MODEL, message: { content: 'tok' }, done: false })}\n`);
        setTimeout(() => res.socket?.destroy(), 50);
      });
    }

    /** Sends a streamed turn and resolves once the client's response has ended, however it ended. */
    function streamUntilItEnds(): Promise<void> {
      return new Promise((resolve) => {
        const req = sendThroughFront({ model: MODEL, stream: true, messages: [] }, (res) => {
          res.resume();
          res.on('close', () => resolve());
        });
        req.on('close', () => resolve());
      });
    }

    it('warns about the failed candidate instead of logging that the client closed', async () => {
      const logged: string[] = [];
      for (const level of ['warn', 'log', 'debug'] as const) {
        const spy = vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
          logged.push(`${level}: ${String(message)}`);
        });
        cleanups.push(() => spy.mockRestore());
      }
      engine = await engineThatDiesAfterOneFrame();
      serveModelFrom(engine.url);
      let settled!: Promise<void>;
      await startFront(async (req, res) => {
        settled = service.proxyRequest({ path: '/api/chat', method: 'POST', body: req.body, model: MODEL, res });
        await settled;
      });

      await streamUntilItEnds();
      await settled;

      expect(logged.some((line) => line.startsWith('warn:') && line.includes('candidate local (ollama) failed'))).toBe(true);
      expect(logged.some((line) => line.includes('client closed'))).toBe(false);
      // Committed, so still one attempt: the failure is reported, never re-placed.
      expect(engine.requests).toHaveLength(1);
    });

    it('rejects on the serving side of a pool hop, so the failure is not swallowed as the sender leaving', async () => {
      engine = await engineThatDiesAfterOneFrame();
      serveModelFrom(engine.url);
      let settled!: Promise<unknown>;
      await startFront(async (req, res) => {
        settled = service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', req.body, res, 'sender.tailxyz.ts.net', MODEL).then(
          () => 'resolved',
          (error: unknown) => error,
        );
        await settled;
      });

      await streamUntilItEnds();

      expect(await settled).toBeInstanceOf(Error);
      expect(loadService.localInFlight()).toBe(0);
    });
  });

  it('leaves a request whose client stays connected alone', async () => {
    // The listener must key on an unfinished response, not on 'close' alone: a response that
    // completed normally also closes, and aborting then would be a no-op at best.
    engine = await startEngine((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: MODEL, message: { content: 'done' }, done: true }));
    });
    serveModelFrom(engine.url);
    await startFront((req, res) => service.proxyRequest({ path: '/api/chat', method: 'POST', body: req.body, model: MODEL, res }));

    const body = await new Promise<string>((resolve, reject) => {
      const req = sendThroughFront({ model: MODEL, messages: [] }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
        res.on('error', reject);
      });
      req.on('error', reject);
    });

    expect(JSON.parse(body)).toMatchObject({ done: true });
    expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', status: 200 });
    expect(loadService.localInFlight()).toBe(0);
  });
});
