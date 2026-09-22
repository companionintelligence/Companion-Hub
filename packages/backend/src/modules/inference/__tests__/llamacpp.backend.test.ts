import { Test, type TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { LLAMACPP_DEFAULT_PORT, LlamacppBackend, parseLlamacppProps } from '../backends/llamacpp.backend';

vi.mock('axios');

describe('LlamacppBackend', () => {
  let backend: LlamacppBackend;
  let loggerService: MockProxy<LoggerService>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [LlamacppBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();
    backend = module.get<LlamacppBackend>(LlamacppBackend);
    // Opted in by default here: this backend probes nothing without it (see the opt-in block below).
    process.env.LLAMACPP_URL = 'http://llama-host:8080';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /*
   * llama-server defaults to 8080 and so does mlx-dspark. Probing it unasked would find dspark on an
   * Apple Silicon host, get a good OpenAI-compatible answer, and report one engine as two healthy
   * backends — double-counting that machine in pool ranking.
   */
  describe('the opt-in', () => {
    it('makes no request at all when LLAMACPP_URL is unset, and says why', async () => {
      delete process.env.LLAMACPP_URL;
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn();

      const health = await backend.healthCheck();

      expect(axios.get).not.toHaveBeenCalled();
      expect(health).toMatchObject({ running: false, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain('LLAMACPP_URL is not set');
    });

    /* Settings still has to be able to test an address the operator typed but has not saved. */
    it('probes an explicit override even while unconfigured', async () => {
      delete process.env.LLAMACPP_URL;
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'typed-model' }] } });
      });

      await expect(backend.healthCheck('http://typed-host:8080')).resolves.toMatchObject({ healthy: true });
      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('typed-host'), expect.any(Object));
    });
  });

  describe('endpoint resolution', () => {
    it("names llama-server's own port when nothing is configured, so a message can quote it", () => {
      delete process.env.LLAMACPP_URL;

      expect(backend.getBaseUrl()).toMatch(new RegExp(`:${LLAMACPP_DEFAULT_PORT}$`));
    });

    /* An operator pastes a URL out of an OpenAI client config, where it ends in /v1. */
    it('accepts a configured URL with a /v1 suffix or a trailing slash and stores the origin', () => {
      process.env.LLAMACPP_URL = 'http://gpu-box:9000/v1';
      expect(backend.getBaseUrl()).toBe('http://gpu-box:9000');

      process.env.LLAMACPP_URL = 'http://gpu-box:9000/';
      expect(backend.getBaseUrl()).toBe('http://gpu-box:9000');
    });

    /* A remote host is left alone — a Mac serving a Hub on another box must keep working. */
    it('leaves a remote hostname untouched', () => {
      process.env.LLAMACPP_URL = 'http://mac-studio.tailnet.ts.net:8080';

      expect(backend.getBaseUrl()).toBe('http://mac-studio.tailnet.ts.net:8080');
    });
  });

  describe('health', () => {
    /*
     * `llama-server` answers /health 503 while it is still mapping the model. Probing it means
     * "loading" reads as unhealthy instead of as ready, which is the distinction that decides
     * whether the pool places a request on a server that would make it wait minutes.
     */
    it('probes /health as well as /v1/models, and reports the model it was started with', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200, data: { status: 'ok' } });
        if (url.endsWith('/props')) return Promise.reject(new Error('404'));
        return Promise.resolve({ data: { data: [{ id: 'qwen3.6-27b-q4_k_m' }] } });
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenNthCalledWith(1, expect.stringContaining('/health'), expect.any(Object));
      expect(axios.get).toHaveBeenNthCalledWith(2, expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health).toEqual({ running: true, healthy: true, modelsLoaded: ['qwen3.6-27b-q4_k_m'] });
      // An older build without /props: healthy, and no statement — never an invented one.
      expect(backend.engineCapabilities()).toBeNull();
    });

    /*
     * The fleet's llama-server is on :8081 and a hand-started one on 8080, dspark's port. Whoever
     * answers says so in `owned_by`; a server that names another engine is that engine's, and this
     * backend must not offer its models a second time.
     */
    it('stands down when the server names another engine, and says which variable points it at its own', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'Qwen/Qwen3.5-9B', owned_by: 'vllm' }] } });
      });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain('set LLAMACPP_URL');
      await expect(backend.listModels()).resolves.toEqual([]);
      expect(backend.engineCapabilities()).toBeNull();
    });
  });

  describe('/props', () => {
    /*
     * Verified against a live llama-server (Ollama's bundled build, `-c 131072 -np 4`): `total_slots`
     * is the slot count and `default_generation_settings.n_ctx` the window EACH slot gets — 32768,
     * not the 131072 the server was started with.
     */
    const props = {
      default_generation_settings: { id: 0, id_task: -1, n_ctx: 32768, speculative: false, params: { n_predict: -1 } },
      total_slots: 4,
      model_path: '/models/blobs/sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a',
      model_alias: 'qwen3-coder:30b',
      build_info: 'b11065-ce8caa6e6',
    };

    it('reads the slot count and the per-slot window, and nothing that is not a positive integer', () => {
      expect(parseLlamacppProps(props)).toEqual({ slots: 4, contextLength: 32768, modelPath: props.model_path });
      expect(parseLlamacppProps({ total_slots: '4', default_generation_settings: { n_ctx: 0 } })).toEqual({
        slots: null,
        contextLength: null,
        modelPath: null,
      });
      expect(parseLlamacppProps(null)).toEqual({ slots: null, contextLength: null, modelPath: null });
    });

    it('is read on a healthy probe and answered from memory afterwards — never a request of its own', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        if (url.endsWith('/props')) return Promise.resolve({ data: props });
        return Promise.resolve({ data: { data: [{ id: 'qwen3-coder:30b', owned_by: 'llamacpp' }] } });
      });
      expect(backend.engineCapabilities()).toBeNull();

      await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledTimes(3);
      expect(axios.get).toHaveBeenNthCalledWith(3, 'http://llama-host:8080/props', expect.objectContaining({ timeout: 5000 }));
      expect(backend.engineCapabilities()).toEqual({ slots: 4, contextLength: 32768 });
      expect(backend.engineCapabilities()).toEqual({ slots: 4, contextLength: 32768 });
      expect(axios.get).toHaveBeenCalledTimes(3);

      // The window it was loaded with is the one residency reports.
      const residency = await backend.listResident();
      expect(residency.models?.[0]?.contextLength).toBe(32768);
    });

    it('forgets the statement when the server stops answering, so the pool never ranks against a dead server’s slots', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        if (url.endsWith('/props')) return Promise.resolve({ data: props });
        return Promise.resolve({ data: { data: [{ id: 'qwen3-coder:30b', owned_by: 'llamacpp' }] } });
      });
      await backend.healthCheck();
      expect(backend.engineCapabilities()).not.toBeNull();

      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      await backend.healthCheck();

      expect(backend.engineCapabilities()).toBeNull();
    });

    it('does not let a typed Settings address overwrite what the configured server said', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        if (url.endsWith('/props')) return Promise.resolve({ data: props });
        return Promise.resolve({ data: { data: [{ id: 'qwen3-coder:30b', owned_by: 'llamacpp' }] } });
      });
      await backend.healthCheck();
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

      await backend.healthCheck('http://typed-host:9999');

      expect(backend.engineCapabilities()).toEqual({ slots: 4, contextLength: 32768 });
    });

    it('is unreachable, not merely empty, when nothing answers', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('ECONNREFUSED');
    });
  });

  describe('residency', () => {
    /*
     * The engine serves exactly the GGUF it was started with, so its inventory IS its residency.
     * Reporting 'measured' would claim the engine was asked, and llama.cpp exposes nothing to ask.
     */
    it("reports 'implicit' residency, with the fields it cannot know left null", async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        if (url.endsWith('/props')) return Promise.reject(new Error('404'));
        return Promise.resolve({ data: { data: [{ id: 'qwen3.6-27b-q4_k_m' }] } });
      });

      const residency = await backend.listResident();

      expect(residency.source).toBe('implicit');
      expect(residency.models).toEqual([
        { id: 'qwen3.6-27b-q4_k_m', engineGpuBytes: null, totalBytes: null, expiresAt: null, contextLength: null, quantization: null },
      ]);
    });

    it("reports 'unreachable' with null models when the server is down", async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

      const residency = await backend.listResident();

      expect(residency.source).toBe('unreachable');
      expect(residency.models).toBeNull();
    });
  });

  describe('serving failures', () => {
    /* Two strikes in the window withhold the model from routing; anything that serves clears it. */
    it('withholds a model that keeps failing, and reports it on the health check', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'broken-model' }] } });
      });

      backend.noteServingFailure('broken-model', 'HTTP 500');
      backend.noteServingFailure('broken-model', 'HTTP 500');

      await expect(backend.healthCheck()).resolves.toMatchObject({ unservableModels: ['broken-model'] });

      backend.noteServingSuccess('broken-model');

      await expect(backend.healthCheck()).resolves.not.toHaveProperty('unservableModels');
    });
  });

  describe('deployment', () => {
    /*
     * The Hub cannot pull a GGUF, so a container it started would come up with no weights. Refusing
     * with that reason beats handing back a compose config that could never run.
     */
    it('refuses to produce an image or a compose config, and says why', () => {
      expect(() => backend.getDockerImage()).toThrow(/does not manage llama-server/i);
      expect(() => backend.getComposeConfig()).toThrow(/cannot pull a GGUF/i);
      expect(() => backend.getComposeConfig()).toThrow(/LLAMACPP_URL/);
    });

    it('says a model change needs a restart rather than reporting a pull it cannot do', async () => {
      const progress = vi.fn();

      await backend.pullModel('anything', progress);

      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percent: 100 }));
      expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('restarting llama-server'));
    });
  });
});
