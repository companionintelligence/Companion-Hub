/**
 * The pool proxy against engines that answer 200 with output that is cut off or degenerate, and the
 * record it keeps of every candidate it passes over.
 *
 * Reproduces the fleet run of 2026-09-29 (bank0929, pool hub core-2, 15 leaves): core-2's own Ollama
 * answered gemma4:e4b with `<unused49>` tokens and streams that ended without `{"done":true}`, its
 * non-streamed bodies came back `done: false`, and the proxy recorded every one as served, never
 * failed over, never struck the engine, and let `poolLocalAffinity` send every retry straight back.
 */

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { OmlxBackend } from '@/modules/inference/backends/omlx.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  DEFAULT_POOL_SLOT_AWARENESS,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolLoadService } from '../hub-pool-load.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { EMPTY_ANSWER_LIMIT, PoolProxyService, describeAttemptError } from '../hub-pool-proxy.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { HubPoolThroughputService } from '../hub-pool-throughput.service';

const MODEL = 'gemma4:e4b';
const PEER_FQDN = 'core-17.tailxyz.ts.net';
const LOCAL_URL = 'http://local-ollama:11434';

function ollamaFrame(content: string, done = false, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ model: MODEL, created_at: '2026-09-29T10:00:00Z', message: { role: 'assistant', content }, done, ...extra })}\n`;
}
const OLLAMA_DONE = ollamaFrame('', true, { done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 });
/** What core-2's broken engine streamed: placeholder tokens, and no closing frame. */
const DEGENERATE_STREAM = Array.from({ length: 30 }, () => ollamaFrame('<unused49>'));
const HEALTHY_STREAM = [ollamaFrame('Hel'), ollamaFrame('lo'), OLLAMA_DONE];

function sseFrame(content: string | null, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finishReason }] })}\n\n`;
}

/** What qwen3-coder's tool-call parser makes Ollama answer on every node: 200, no content, no finish_reason, zero usage. */
const EMPTY_COMPLETION = JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});
const OK_COMPLETION = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] });

const NDJSON = 'application/x-ndjson';
/** What Ollama and the OpenAI-compatible engines label a non-streamed completion. */
const JSON_BODY = 'application/json; charset=utf-8';

/** A fresh streamed 200 each call: a `Response` body can only be read once. */
function streamed(chunks: string[], status = 200, contentType = NDJSON): globalThis.Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': contentType } },
  );
}

/** A non-streamed completion, labelled as the engines label one. */
function whole(body: string): globalThis.Response {
  return streamed([body], 200, JSON_BODY);
}

/**
 * A 200 that sends `first` and then nothing more until `release()`, which sends `rest` and ends it —
 * an engine still generating, so a test can look at what the caller had been sent by then.
 */
function gated(first: string[], rest: string[], contentType = NDJSON): { response: globalThis.Response; release: () => void } {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        for (const chunk of first) controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { 'Content-Type': contentType } },
  );
  return {
    response,
    release: () => {
      for (const chunk of rest) stream.enqueue(encoder.encode(chunk));
      stream.close();
    },
  };
}

/**
 * A 200 that sends `frames` and then fails, as Node's `fetch` reports an engine whose connection
 * dropped mid-generation. Failing from `pull`, after the frames were read: erroring the stream while
 * they were still queued would discard them, and the engine would not have sent anything at all.
 */
function dying(frames: string[], contentType = NDJSON): globalThis.Response {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          return;
        }
        controller.error(new TypeError('terminated'));
      },
    }),
    { status: 200, headers: { 'Content-Type': contentType } },
  );
}

function createMockResponse(): Response & { chunks: Buffer[]; text: () => string } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  }) as unknown as Response & { chunks: Buffer[]; text: () => string };
  writable.on('error', () => {});
  writable.chunks = chunks;
  writable.text = () => Buffer.concat(chunks).toString('utf8');
  writable.status = vi.fn().mockReturnValue(writable) as unknown as typeof writable.status;
  writable.setHeader = vi.fn().mockReturnValue(writable) as unknown as typeof writable.setHeader;
  writable.json = vi.fn().mockReturnValue(writable) as unknown as typeof writable.json;
  return writable;
}

describe('pool proxy: degenerate and cut-off output, and why candidates were passed over', () => {
  let ollama: MockProxy<OllamaBackend>;
  let peerService: MockProxy<HubPoolPeerService>;
  let configuration: MockProxy<ConfigurationService>;
  let routingLog: HubPoolRoutingLogService;
  let service: PoolProxyService;
  let warnings: string[];
  let infos: string[];
  const spies: Array<{ mockRestore: () => void }> = [];

  function setLocalAffinity(poolLocalAffinity: number): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolPins: [],
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      poolMaxPromptTokens: null,
      poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      poolPrefixAffinityMaxInFlight: DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
      poolSlotAwareness: DEFAULT_POOL_SLOT_AWARENESS,
    } as unknown as HubPoolPreferences);
  }

  function peerWithModel(): HubPoolPeer {
    return {
      id: 'peer-17',
      tailscaleDeviceId: null,
      nodeFqdn: PEER_FQDN,
      displayName: 'core-17',
      direction: 'outbound',
      status: 'connected',
      enabled: true,
      consecutiveFailures: 0,
      lastSeenAt: new Date().toISOString(),
      lastCapabilities: {
        hardwareTier: 'high',
        backends: [{ type: 'ollama', healthy: true, modelsLoaded: [MODEL] }],
        inFlightRequests: 0,
        updatedAt: new Date().toISOString(),
      },
      verifyTokenHash: 'hash',
      presentTokenEncrypted: 'encrypted',
      peerNodeUuid: null,
      peerPublicKey: null,
      bearerGraceUntil: null,
      signedSeenAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as HubPoolPeer;
  }

  /** Answers the local engine and the peer from separate scripts, and records which was asked, in order. */
  function engines(local: () => globalThis.Response, peer: () => globalThis.Response): string[] {
    const asked: string[] = [];
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const isLocal = String(url).startsWith(LOCAL_URL);
      asked.push(isLocal ? 'local' : 'peer');
      return isLocal ? local() : peer();
    });
    return asked;
  }

  /** The body a chat turn sends; `stream: 'omitted'` leaves the field out, as most Ollama-native clients do. */
  function chatBody(stream: boolean | 'omitted' = true): Record<string, unknown> {
    return { model: MODEL, ...(stream === 'omitted' ? {} : { stream }), messages: [{ role: 'user', content: 'hi' }] };
  }

  function startChat(options: { stream?: boolean | 'omitted'; path?: string } = {}): {
    res: Response & { text: () => string };
    routed: Promise<void>;
  } {
    const res = createMockResponse();
    const routed = service.proxyRequest({ path: options.path ?? '/api/chat', method: 'POST', body: chatBody(options.stream), model: MODEL, res });
    return { res, routed };
  }

  async function chat(options: { stream?: boolean | 'omitted'; path?: string } = {}): Promise<Response & { text: () => string }> {
    const { res, routed } = startChat(options);
    await routed;
    return res;
  }

  /** A peer forward of one chat turn to this node's own engine, as the peer-facing route makes it. */
  function forwardFromPeer(stream: boolean | 'omitted' = true): Promise<void> {
    return service.forwardToLocalBackendAndRespond(
      'ollama',
      '/api/chat',
      'POST',
      chatBody(stream),
      createMockResponse(),
      'core-2.tailxyz.ts.net',
      MODEL,
    );
  }

  beforeEach(() => {
    ollama = mock<OllamaBackend>();
    const others = [mock<VllmBackend>(), mock<LemonadeBackend>(), mock<OmlxBackend>()];
    for (const backend of others) backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
    ollama.getBaseUrl.mockReturnValue(LOCAL_URL);
    configuration = mock<ConfigurationService>();
    setLocalAffinity(1);
    peerService = mock<HubPoolPeerService>();
    const peer = peerWithModel();
    peerService.listConnectedPeers.mockResolvedValue([peer]);
    peerService.getPeerById.mockResolvedValue(peer);
    peerService.peerAuthHeaders.mockResolvedValue({});
    const pressureService = mock<HubPoolPressureService>();
    pressureService.band.mockReturnValue(null);
    routingLog = new HubPoolRoutingLogService();
    service = new PoolProxyService(
      new InferenceBackendRegistry(ollama, ...(others as unknown as [VllmBackend, LemonadeBackend, OmlxBackend])),
      peerService,
      mock<TailscaleService>(),
      new HubPoolLoadService(),
      configuration,
      routingLog,
      pressureService,
    );
    global.fetch = vi.fn();
    warnings = [];
    infos = [];
    spies.push(
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
        warnings.push(String(message));
      }),
      vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
        infos.push(String(message));
      }),
    );
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    vi.useRealTimers();
  });

  describe('a stream the node cut off or filled with placeholders', () => {
    it('settles an Ollama stream that ends without done:true as the node failing, not as served', async () => {
      engines(
        () => streamed([ollamaFrame('Hel'), ollamaFrame('lo')]),
        () => streamed(HEALTHY_STREAM),
      );

      const res = await chat();

      // The bytes still went to the caller: a stream cannot be recalled once it is on the wire.
      expect(res.text()).toBe([ollamaFrame('Hel'), ollamaFrame('lo')].join(''));
      const row = routingLog.list()[0];
      expect(row).toMatchObject({
        node: 'local',
        outcome: 'failed',
        status: 200,
        requestError: { signature: 'truncated-upstream', basis: 'node', confirms: null },
        reason: 'truncated-upstream',
        failedOverFrom: [],
      });
      expect(routingLog.summary()).toMatchObject({ served: 0, failed: 1, requestErrors: 0, outputFaults: 1 });
    });

    it('names a stream of <unused49> degenerate', async () => {
      engines(
        () => streamed(DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );

      await chat();

      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', requestError: { signature: 'degenerate-output', basis: 'node' } });
    });

    it('leaves healthy streams served — Ollama with its eval counts or without, OpenAI with a usage frame or without', async () => {
      const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`;
      const scripts = [
        HEALTHY_STREAM,
        [ollamaFrame('Hello'), ollamaFrame('', true)],
        [sseFrame('Hi'), sseFrame(null, 'stop'), 'data: [DONE]\n\n'],
        [sseFrame('Hi'), sseFrame(null, 'stop'), usage, 'data: [DONE]\n\n'],
      ];
      for (const [index, script] of scripts.entries()) {
        engines(
          () => streamed(script),
          () => streamed(HEALTHY_STREAM),
        );
        await chat({ path: index < 2 ? '/api/chat' : '/v1/chat/completions' });
      }

      for (const row of routingLog.list()) {
        expect(row).toMatchObject({ outcome: 'served', status: 200, requestError: null, reason: null });
      }
      expect(routingLog.summary()).toMatchObject({ served: 4, failed: 0, outputFaults: 0 });
    });

    it('reads an OpenAI stream without [DONE] or a finish_reason as cut off', async () => {
      engines(
        () => streamed([sseFrame('Hel'), sseFrame('lo')]),
        () => streamed(HEALTHY_STREAM),
      );

      await chat({ path: '/v1/chat/completions' });

      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', requestError: { signature: 'truncated-upstream', basis: 'node' } });
    });

    it('reads an OpenAI stream that reported an error frame as cut off, though [DONE] followed it', async () => {
      // How vLLM ends a generation its engine failed part-way through.
      const errorFrame = `data: ${JSON.stringify({ error: { object: 'error', message: 'engine died', type: 'InternalServerError', code: 500 } })}\n\n`;
      engines(
        () => streamed([sseFrame('Hel'), errorFrame, 'data: [DONE]\n\n'], 200, 'text/event-stream'),
        () => streamed(HEALTHY_STREAM),
      );

      await chat({ path: '/v1/chat/completions' });

      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'failed',
        requestError: { signature: 'truncated-upstream', basis: 'node' },
        reason: 'truncated-upstream',
      });
    });

    it('records a stream the engine dropped mid-generation as the node failing it', async () => {
      engines(
        () => dying([ollamaFrame('Hel')]),
        () => streamed(HEALTHY_STREAM),
      );

      const res = await chat();

      expect(res.text()).toBe(ollamaFrame('Hel'));
      expect(routingLog.list()[0]).toMatchObject({
        node: 'local',
        outcome: 'failed',
        requestError: { signature: 'truncated-upstream', basis: 'node' },
        failedOverFrom: [],
      });
    });

    it('records the whole response time beside the time to headers', async () => {
      engines(
        () => streamed(HEALTHY_STREAM),
        () => streamed(HEALTHY_STREAM),
      );

      await chat();

      const row = routingLog.list()[0];
      expect(row?.durationMs).toEqual(expect.any(Number));
      expect(row?.totalMs).toEqual(expect.any(Number));
      expect(row?.totalMs ?? -1).toBeGreaterThanOrEqual(row?.durationMs ?? 0);
    });
  });

  describe('an Ollama-native turn that leaves `stream` out, which Ollama streams', () => {
    it('relays each frame as the engine sends it, rather than holding the whole generation', async () => {
      const { response, release } = gated([ollamaFrame('Hel')], [ollamaFrame('lo'), OLLAMA_DONE]);
      engines(
        () => response,
        () => streamed(HEALTHY_STREAM),
      );

      const { res, routed } = startChat({ stream: 'omitted' });

      // The engine is still generating, and the caller already has its first frame.
      await vi.waitFor(() => expect(res.text()).toBe(ollamaFrame('Hel')));
      expect(res.status).toHaveBeenCalledWith(200);
      release();
      await routed;
      expect(res.text()).toBe([ollamaFrame('Hel'), ollamaFrame('lo'), OLLAMA_DONE].join(''));
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', stream: true, requestError: null });
    });

    it('judges the stream it relays: placeholder tokens are degenerate, a missing done:true is cut off', async () => {
      engines(
        () => streamed(DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat({ stream: 'omitted' });
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', requestError: { signature: 'degenerate-output', basis: 'node' } });

      engines(
        () => streamed([ollamaFrame('Hel'), ollamaFrame('lo')]),
        () => streamed(HEALTHY_STREAM),
      );
      await chat({ stream: 'omitted' });
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', requestError: { signature: 'truncated-upstream', basis: 'node' } });
    });

    it('relays an engine that streams a stream:false request as it streams, by what it answered with', async () => {
      const { response, release } = gated([ollamaFrame('Hel')], [ollamaFrame('lo'), OLLAMA_DONE]);
      engines(
        () => response,
        () => streamed(HEALTHY_STREAM),
      );

      const { res, routed } = startChat({ stream: false });

      await vi.waitFor(() => expect(res.text()).toBe(ollamaFrame('Hel')));
      release();
      await routed;
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', requestError: null });
    });
  });

  describe('a non-streamed body the node cut off', () => {
    it('fails over to the next candidate instead of relaying a done:false body', async () => {
      const asked = engines(
        () => whole(ollamaFrame('partial', false)),
        () => whole(ollamaFrame('Hello from core-17', true)),
      );

      const res = await chat({ stream: false });

      expect(asked).toEqual(['local', 'peer']);
      // Only the peer's answer reached the caller.
      expect(res.text()).toBe(ollamaFrame('Hello from core-17', true));
      expect(routingLog.list()[0]).toMatchObject({
        node: PEER_FQDN,
        outcome: 'served',
        attempt: 2,
        failedOverFrom: ['local'],
        attempts: [{ node: 'local', backend: 'ollama', status: 200, reason: 'truncated-upstream' }],
        requestError: null,
      });
      expect(
        warnings.some((line) => line.includes('local (ollama) failed "gemma4:e4b"') && line.includes('failing over (1 candidate(s) left)')),
      ).toBe(true);
    });

    it('relays a degenerate body from the last candidate as it came, and records the node failing it', async () => {
      peerService.listConnectedPeers.mockResolvedValue([]);
      const body = ollamaFrame('<unused49>'.repeat(30), true);
      engines(
        () => whole(body),
        () => streamed(HEALTHY_STREAM),
      );

      const res = await chat({ stream: false });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.text()).toBe(body);
      expect(routingLog.list()[0]).toMatchObject({
        node: 'local',
        outcome: 'failed',
        requestError: { signature: 'degenerate-output', basis: 'node' },
        failedOverFrom: [],
      });
    });
  });

  describe('a body every node answers with nothing in it', () => {
    it('stops asking after EMPTY_ANSWER_LIMIT empty 200s and fails the request rather than walking every node', async () => {
      const peers = Array.from({ length: 6 }, (_, n) => ({ ...peerWithModel(), id: `peer-${n}`, nodeFqdn: `core-${n}.tailxyz.ts.net` }));
      peerService.listConnectedPeers.mockResolvedValue(peers);
      let asked = 0;
      vi.mocked(global.fetch).mockImplementation(async () => {
        asked += 1;
        return whole(EMPTY_COMPLETION);
      });

      const res = await chat({ stream: false, path: '/v1/chat/completions' });

      expect(asked).toBe(EMPTY_ANSWER_LIMIT);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed' });
    });

    it('still walks on when only one node answers empty', async () => {
      const asked = engines(
        () => whole(EMPTY_COMPLETION),
        () => whole(OK_COMPLETION),
      );

      const res = await chat({ stream: false, path: '/v1/chat/completions' });

      expect(asked).toEqual(['local', 'peer']);
      expect(res.text()).toBe(OK_COMPLETION);
    });
  });

  describe('withholding an engine that keeps answering with bad output', () => {
    it('withholds the local engine after two faults, overriding local affinity, with one warn line saying why', async () => {
      // An affinity no peer could outscore on load alone.
      setLocalAffinity(5);
      const asked = engines(
        () => streamed(DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );

      await chat();
      await chat();
      expect(asked).toEqual(['local', 'local']);
      const withholds = warnings.filter((line) => line.includes('withholding it from routing'));
      expect(withholds).toHaveLength(1);
      expect(withholds[0]).toContain('local ollama answered "gemma4:e4b" with degenerate output');
      expect(withholds[0]).toContain('2 times within 5 minutes');

      asked.length = 0;
      await chat();

      // The retry goes elsewhere, and is served there.
      expect(asked).toEqual(['peer']);
      expect(routingLog.list()[0]).toMatchObject({ node: PEER_FQDN, outcome: 'served', attempt: 1 });
    });

    it('withholds an engine that keeps dropping its stream mid-generation, overriding local affinity', async () => {
      setLocalAffinity(5);
      const asked = engines(
        () => dying([ollamaFrame('Hel')]),
        () => streamed(HEALTHY_STREAM),
      );

      await chat();
      await chat();
      expect(asked).toEqual(['local', 'local']);
      expect(routingLog.list().map((row) => `${row.outcome}/${row.reason}`)).toEqual(['failed/truncated-upstream', 'failed/truncated-upstream']);
      const withholds = warnings.filter((line) => line.includes('withholding it from routing'));
      expect(withholds).toHaveLength(1);
      expect(withholds[0]).toContain('local ollama answered "gemma4:e4b" with a truncated response');

      asked.length = 0;
      await chat();

      expect(asked).toEqual(['peer']);
      expect(routingLog.list()[0]).toMatchObject({ node: PEER_FQDN, outcome: 'served', attempt: 1 });
    });

    it('withholds an engine whose non-streamed bodies keep breaking off before they end', async () => {
      setLocalAffinity(5);
      const asked = engines(
        () => dying(['{"model":"gemma4:e4b","message":{"role":"assistant","content":"Hel'], JSON_BODY),
        () => whole(ollamaFrame('Hello from core-17', true)),
      );

      await chat({ stream: false });
      // Caught before anything was sent, so the next candidate answered instead.
      expect(asked).toEqual(['local', 'peer']);
      expect(routingLog.list()[0]).toMatchObject({
        node: PEER_FQDN,
        outcome: 'served',
        failedOverFrom: ['local'],
        attempts: [{ node: 'local', status: null, reason: expect.stringContaining('failed mid-body') }],
      });
      await chat({ stream: false });

      asked.length = 0;
      await chat({ stream: false });

      expect(asked).toEqual(['peer']);
    });

    it('records no throughput from an answer the node failed, so a fast degenerate engine does not read as a fast one', async () => {
      const recordPrefill = vi.spyOn(HubPoolThroughputService.prototype, 'recordPrefill');
      spies.push(recordPrefill);
      engines(
        () => streamed(DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      engines(
        () => dying([ollamaFrame('Hel')]),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      expect(recordPrefill).not.toHaveBeenCalled();

      // The same engine answering properly is measured as before.
      engines(
        () => streamed(HEALTHY_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      expect(recordPrefill).toHaveBeenCalledTimes(1);
    });

    it('still asks a withheld engine when every other candidate fails — demoted, never removed', async () => {
      const asked = engines(
        () => streamed(DEGENERATE_STREAM),
        () => new Response('busy', { status: 503 }),
      );
      await chat();
      await chat();

      asked.length = 0;
      await chat();

      expect(asked).toEqual(['peer', 'local']);
    });

    it('restores the engine once the cooldown runs out', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'));
      let localHealthy = false;
      const asked = engines(
        () => streamed(localHealthy ? HEALTHY_STREAM : DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      await chat();
      asked.length = 0;
      await chat();
      expect(asked).toEqual(['peer']);

      // The operator fixes the node; the cooldown (60 s the first time) runs out.
      localHealthy = true;
      vi.setSystemTime(new Date('2026-09-29T10:01:01.000Z'));
      asked.length = 0;
      await chat();

      expect(asked).toEqual(['local']);
      expect(routingLog.list()[0]).toMatchObject({ node: 'local', outcome: 'served' });
      expect(infos.some((line) => line.includes('cleanly again — no longer withheld'))).toBe(true);
    });

    it('withholds a peer engine the same way', async () => {
      setLocalAffinity(1);
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
      const peer2 = { ...peerWithModel(), id: 'peer-7', nodeFqdn: 'core-7.tailxyz.ts.net' };
      peerService.listConnectedPeers.mockResolvedValue([peerWithModel(), peer2]);
      peerService.getPeerById.mockImplementation(async (id: string) => (id === 'peer-7' ? peer2 : peerWithModel()));
      const asked: string[] = [];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const node = String(url).includes('core-7') ? 'core-7' : 'core-17';
        asked.push(node);
        return streamed(node === 'core-17' ? DEGENERATE_STREAM : HEALTHY_STREAM);
      });

      await chat();
      await chat();
      asked.length = 0;
      await chat();

      expect(asked).toEqual(['core-7']);
    });
  });

  describe('why each candidate was passed over', () => {
    it('records the status a node failed with, and logs the failover', async () => {
      engines(
        () => new Response(JSON.stringify({ error: 'model failed to load' }), { status: 500 }),
        () => streamed(HEALTHY_STREAM),
      );

      await chat();

      expect(routingLog.list()[0]).toMatchObject({
        node: PEER_FQDN,
        outcome: 'served',
        failedOverFrom: ['local'],
        attempts: [{ node: 'local', backend: 'ollama', status: 500, reason: 'HTTP 500' }],
      });
      expect(warnings).toContain('[PoolProxy] local (ollama) failed "gemma4:e4b": HTTP 500; failing over (1 candidate(s) left)');
      expect(routingLog.summary()).toMatchObject({ served: 1, failovers: 1 });
    });

    it('records each reason when every candidate fails, and the last one as the row’s', async () => {
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        if (String(url).startsWith(LOCAL_URL)) return new Response('busy', { status: 503 });
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      });

      await chat();

      expect(routingLog.list()[0]).toMatchObject({
        node: null,
        outcome: 'failed',
        failedOverFrom: ['local', PEER_FQDN],
        attempts: [
          { node: 'local', status: 503, reason: 'HTTP 503' },
          { node: PEER_FQDN, status: null, reason: 'fetch failed (ECONNREFUSED)' },
        ],
        reason: 'fetch failed (ECONNREFUSED)',
      });
    });

    it('describes an attempt error by its deadline or code, and keeps it short', () => {
      expect(describeAttemptError(new Error('No response headers within 327000ms'))).toBe('No response headers within 327000ms');
      expect(describeAttemptError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(
        'fetch failed (UND_ERR_SOCKET)',
      );
      expect(describeAttemptError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(200);
    });
  });

  describe('the leaf side of a pool hop', () => {
    it('says why an inbound row ended 5xx', async () => {
      vi.mocked(global.fetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'model failed to load' }), { status: 500 }));
      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'core-2.tailxyz.ts.net',
        MODEL,
      );

      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ error: 'no user query found in messages' }), { status: 500 }),
      );
      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'core-2.tailxyz.ts.net',
        MODEL,
      );

      const [second, first] = routingLog.list();
      expect(first).toMatchObject({ direction: 'inbound', model: MODEL, status: 500, outcome: 'failed', reason: 'HTTP 500', requestError: null });
      expect(second).toMatchObject({ direction: 'inbound', status: 500, reason: 'HTTP 500 (no-user-query)' });
    });

    it('records a degenerate answer from this node’s engine against it, so its own apps stop using it too', async () => {
      vi.mocked(global.fetch).mockImplementation(async () => streamed(DEGENERATE_STREAM));
      for (let i = 0; i < 2; i += 1) {
        await service.forwardToLocalBackendAndRespond(
          'ollama',
          '/api/chat',
          'POST',
          { model: MODEL, stream: true },
          createMockResponse(),
          'core-2.tailxyz.ts.net',
          MODEL,
        );
      }
      expect(routingLog.list()[0]).toMatchObject({ direction: 'inbound', outcome: 'failed', status: 200, reason: 'degenerate-output' });
      expect(routingLog.summary()).toMatchObject({ outputFaults: 2 });

      const asked = engines(
        () => streamed(DEGENERATE_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      expect(asked).toEqual(['peer']);
    });

    it('strikes this node’s engine when it drops a peer’s stream mid-generation', async () => {
      vi.mocked(global.fetch).mockImplementation(async () => dying([ollamaFrame('Hel')]));
      for (let i = 0; i < 2; i += 1) {
        await expect(forwardFromPeer()).rejects.toThrow('failed mid-body');
      }
      expect(routingLog.list()[0]).toMatchObject({ direction: 'inbound', outcome: 'failed', status: 200, reason: 'truncated-upstream' });

      const asked = engines(
        () => streamed(HEALTHY_STREAM),
        () => streamed(HEALTHY_STREAM),
      );
      await chat();
      expect(asked).toEqual(['peer']);
    });

    it('judges a peer’s forward that left `stream` out as the stream Ollama sends', async () => {
      vi.mocked(global.fetch).mockImplementation(async () => streamed(DEGENERATE_STREAM));
      await forwardFromPeer('omitted');

      expect(routingLog.list()[0]).toMatchObject({ direction: 'inbound', outcome: 'failed', stream: true, reason: 'degenerate-output' });
    });

    it('marks a forward the sender gave up on as the sender leaving, not as this node failing', async () => {
      vi.mocked(global.fetch).mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit).signal as AbortSignal;
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      );
      const res = createMockResponse();

      const forwarded = service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL, stream: true },
        res,
        'core-2.tailxyz.ts.net',
        MODEL,
      );
      await new Promise((resolve) => setImmediate(resolve));
      // The sending Hub's walk moved on: its fetch closes this response unfinished, with no error.
      res.destroy();
      await forwarded;

      expect(routingLog.list()[0]).toMatchObject({
        direction: 'inbound',
        model: MODEL,
        outcome: 'failed',
        status: null,
        clientClosed: true,
        reason: null,
      });
      expect(routingLog.summary()).toMatchObject({ failed: 1, clientClosed: 1 });
    });
  });
});
