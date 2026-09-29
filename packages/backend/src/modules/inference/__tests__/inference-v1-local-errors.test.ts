import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';

vi.mock('../../app-lifecycle/app-lifecycle.service', () => ({
  AppLifecycleService: class AppLifecycleService {},
}));
vi.mock('../../app-lifecycle/ai-app-inference-refresh.service', () => ({
  AiAppInferenceRefreshService: class AiAppInferenceRefreshService {},
}));

import { AiAppInferenceRefreshService } from '../../app-lifecycle/ai-app-inference-refresh.service';
import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { RocmInstallerService } from '../rocm-installer.service';
import { AppCredentialsService } from '../app-credentials.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { ModelResidencyService } from '../model-residency.service';
import { BackendObserverService } from '../supervision/backend-observer.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OmlxBackend } from '../backends/omlx.backend';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';

/** Ollama's `/v1` answer to `tools` on a model without tool support, as beta-red sent it on 2026-09-29. */
const TOOLS_REFUSAL = {
  error: {
    message: 'registry.ollama.ai/library/gemma3:4b does not support tools',
    type: 'invalid_request_error',
    param: null,
    code: null,
  },
};

/**
 * The local (no-peer) `/v1` path, end to end over real HTTP: a real Nest server running the real
 * controller and the real `InferenceRouterService`, whose axios calls land on a fake engine in this
 * file. Both ends are real on purpose. The defect this pins was invisible to any test that mocks
 * axios: what a client sees depends on the exact error object axios builds — and for a streamed
 * request, on its error body arriving as a socket stream rather than parsed JSON — and on the status
 * Nest leaves on a `@Res()` response, which only a real dispatch shows.
 */
describe('InferenceController — local /v1 path answers with the engine, not a 502', () => {
  let app: INestApplication;
  let baseUrl: string;
  let engine: http.Server;
  let engineUrl: string;
  let deadEngineUrl: string;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let router: InferenceRouterService;
  let engineRequests: Array<{ path: string; body: Record<string, unknown> }>;

  beforeAll(async () => {
    engine = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        engineRequests.push({ path: req.url ?? '', body });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (body.tools) {
          json(400, TOOLS_REFUSAL);
          return;
        }
        const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string }>) : [];
        if (req.url === '/v1/chat/completions' && !messages.some((m) => m.role === 'user')) {
          // Ollama's Go renderer for Qwen-family templates, in its native error shape (core-2, 2026-09-26).
          json(500, { error: 'no user query found in messages' });
          return;
        }
        if (req.url === '/v1/embeddings') {
          json(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }] });
          return;
        }
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.end('data: [DONE]\n\n');
          return;
        }
        json(200, { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }] });
      });
    });
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
    engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;

    // A port that was just free and is closed again: a refused connection, the real transport failure.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    deadEngineUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    ollamaBackend = mock<OllamaBackend>();
    const offline = { running: false, healthy: false, modelsLoaded: [] as string[] };
    const vllm = mock<VllmBackend>();
    vllm.healthCheck.mockResolvedValue(offline);
    const lemonade = mock<LemonadeBackend>();
    lemonade.healthCheck.mockResolvedValue(offline);
    const omlx = mock<OmlxBackend>();
    omlx.healthCheck.mockResolvedValue(offline);

    const modelRegistry = mock<ModelRegistryService>();
    modelRegistry.getTrackedModels.mockReturnValue([]);
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    modelRegistry.getCatalog.mockReturnValue([]);
    modelRegistry.getPinnedModels.mockReturnValue([]);
    modelRegistry.getLoadedModels.mockReturnValue([]);
    const cloudFallback = mock<CloudFallbackService>();
    cloudFallback.getEnabledProviders.mockReturnValue([]);
    cloudFallback.resolveProvider.mockReturnValue(undefined);
    const poolPeers = mock<HubPoolPeerService>();
    poolPeers.hasConnectedPeers.mockResolvedValue(false);

    const moduleRef = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        // The real router: its axios calls are the thing under test.
        InferenceRouterService,
        InferenceBackendRegistry,
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: vllm },
        { provide: LemonadeBackend, useValue: lemonade },
        { provide: OmlxBackend, useValue: omlx },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: CloudFallbackService, useValue: cloudFallback },
        { provide: HubPoolPeerService, useValue: poolPeers },
        { provide: AiAppInferenceRefreshService, useValue: { requestRefresh: vi.fn() } },
        { provide: HardwareInspectorService, useValue: mock<HardwareInspectorService>() },
        { provide: MemoryManagerService, useValue: mock<MemoryManagerService>() },
        { provide: ModelPullerService, useValue: mock<ModelPullerService>() },
        { provide: OllamaInstallerService, useValue: mock<OllamaInstallerService>() },
        { provide: RocmInstallerService, useValue: mock<RocmInstallerService>() },
        { provide: AppCredentialsService, useValue: mock<AppCredentialsService>() },
        { provide: DockerReadFacade, useValue: mock<DockerReadFacade>() },
        { provide: HostMetricsService, useValue: mock<HostMetricsService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: ModelResidencyService, useValue: mock<ModelResidencyService>() },
        { provide: BackendObserverService, useValue: mock<BackendObserverService>() },
        { provide: PoolProxyService, useValue: mock<PoolProxyService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ApiKeyService, useValue: mock<ApiKeyService>() },
      ],
    }).compile();

    router = moduleRef.get(InferenceRouterService);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('/api');
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/inference`;
  }, 30_000);

  beforeEach(() => {
    engineRequests = [];
    vi.restoreAllMocks();
    // A healthy Ollama holding one model, at the fake engine. Tests that need a dead engine re-point it.
    ollamaBackend.getBaseUrl.mockReturnValue(engineUrl);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:4b'] });
    ollamaBackend.getApiKey.mockReturnValue(undefined);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => engine?.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const chatWithTools = {
    model: 'gemma3:4b',
    messages: [{ role: 'user', content: 'what is the weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
  };

  it("relays the engine's 400 and its message for tools on a model without tool support — not 502 'Request failed with status code 400'", async () => {
    const res = await post('/v1/chat/completions', chatWithTools);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // Ollama's body is already OpenAI-shaped, so it goes through untouched, extra fields and all.
    await expect(res.json()).resolves.toEqual(TOOLS_REFUSAL);
    expect(engineRequests).toHaveLength(1);
  });

  it('relays the same 400 for a STREAMED request, whose error body axios hands over as a socket stream', async () => {
    const res = await post('/v1/chat/completions', { ...chatWithTools, stream: true });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    await expect(res.json()).resolves.toEqual(TOOLS_REFUSAL);
  });

  it("wraps an engine's native error shape in OpenAI's envelope, and answers a request-fault 500 as a 400 like the pool does", async () => {
    const res = await post('/v1/chat/completions', { model: 'gemma3:4b', messages: [{ role: 'system', content: 'be brief' }] });
    // A 500 that the pool's own classifier knows to be the request's fault: an SDK must not retry it.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: { message: 'no user query found in messages', type: 'invalid_request_error' } });
  });

  it('keeps 502 for a refused connection — the one case where nothing answered', async () => {
    ollamaBackend.getBaseUrl.mockReturnValue(deadEngineUrl);
    const res = await post('/v1/chat/completions', { model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('server_error');
    expect(body.error.message).toMatch(/ECONNREFUSED/);
  });

  it('keeps 502 for a refused connection on a streamed request too', async () => {
    ollamaBackend.getBaseUrl.mockReturnValue(deadEngineUrl);
    const res = await post('/v1/chat/completions', { model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('server_error');
  });

  it('answers a model no backend or provider has with 404 model_not_found, on chat and on completions', async () => {
    const chat = await post('/v1/chat/completions', { model: 'nope:1b', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(404);
    await expect(chat.json()).resolves.toEqual({
      error: { message: 'Model nope:1b not found or not available', type: 'invalid_request_error', code: 'model_not_found' },
    });

    // The exact request that answered `502 server_error` on beta-red, 2026-09-29.
    const completions = await post('/v1/completions', { model: 'nope:1b', prompt: 'def f(' });
    expect(completions.status).toBe(404);
    await expect(completions.json()).resolves.toMatchObject({ error: { type: 'invalid_request_error', code: 'model_not_found' } });
    expect(engineRequests).toHaveLength(0);
  });

  it('answers a local success with 200, not the 201 Nest defaults a POST to — chat, streamed chat, completions and embeddings', async () => {
    const chat = await post('/v1/chat/completions', { model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(200);
    await expect(chat.json()).resolves.toMatchObject({ object: 'chat.completion' });

    const streamed = await post('/v1/chat/completions', { model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toMatch(/text\/event-stream/);
    await expect(streamed.text()).resolves.toContain('data: [DONE]');

    const completions = await post('/v1/completions', { model: 'gemma3:4b', prompt: 'def f(' });
    expect(completions.status).toBe(200);

    const embeddings = await post('/v1/embeddings', { model: 'nomic-embed-text', input: 'hello' });
    expect(embeddings.status).toBe(200);
    await expect(embeddings.json()).resolves.toMatchObject({ object: 'list' });
  });

  it('answers speech with 200 and the audio type', async () => {
    vi.spyOn(router, 'routeTts').mockResolvedValue({ data: Buffer.from('ID3'), backend: 'lemonade' });
    const res = await post('/v1/audio/speech', { model: 'kokoro', input: 'hi', response_format: 'wav' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
  });

  describe('transcriptions', () => {
    const transcribe = (fields: Record<string, string>) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }), 'turn.wav');
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      return fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: form });
    };

    it('sends a response_format=text transcript as plain text, unquoted (#1643)', async () => {
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: 'hello world\n', backend: 'lemonade' });
      const res = await transcribe({ model: 'whisper-base', response_format: 'text' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      await expect(res.text()).resolves.toBe('hello world\n');
    });

    it('sends vtt as text/vtt and srt as plain text', async () => {
      const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n';
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: vtt, backend: 'lemonade' });
      const vttRes = await transcribe({ response_format: 'vtt' });
      expect(vttRes.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
      await expect(vttRes.text()).resolves.toBe(vtt);

      const srt = '1\n00:00:00,000 --> 00:00:01,000\nhello\n';
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: srt, backend: 'lemonade' });
      const srtRes = await transcribe({ response_format: 'srt' });
      expect(srtRes.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      await expect(srtRes.text()).resolves.toBe(srt);
    });

    it('sends a transcript that axios already parsed as JSON ("42") as its text', async () => {
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: 42, backend: 'lemonade' });
      const res = await transcribe({ response_format: 'text' });
      await expect(res.text()).resolves.toBe('42');
    });

    it('still sends JSON for the default and json formats, and for an engine that answered JSON anyway', async () => {
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: { text: 'hello' }, backend: 'lemonade' });
      const plain = await transcribe({});
      expect(plain.status).toBe(200);
      expect(plain.headers.get('content-type')).toMatch(/application\/json/);
      await expect(plain.json()).resolves.toEqual({ text: 'hello' });

      const asked = await transcribe({ response_format: 'text' });
      expect(asked.headers.get('content-type')).toMatch(/application\/json/);
      await expect(asked.json()).resolves.toEqual({ text: 'hello' });
    });

    it('ignores a response_format that only names an Object prototype key', async () => {
      vi.spyOn(router, 'routeStt').mockResolvedValue({ data: 'hello', backend: 'lemonade' });
      const res = await transcribe({ response_format: 'constructor' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });
  });
});
