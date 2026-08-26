import { Test, type TestingModule } from '@nestjs/testing';
import { buildDsparkRemediation, DsparkBackend, normalizeDsparkBaseUrl, resolveDsparkProbeUrl } from '../backends/dspark.backend';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

const TARGET = 'mlx-community/Qwen3-8B-8bit';

describe('DsparkBackend', () => {
  let backend: DsparkBackend;
  let loggerService: MockProxy<LoggerService>;
  let configurationService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    configurationService = mock<ConfigurationService>();
    configurationService.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
      preferredVllmUrl: null,
      preferredDsparkUrl: null,
    });
    delete process.env.DSPARK_URL;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DsparkBackend,
        { provide: LoggerService, useValue: loggerService },
        { provide: ConfigurationService, useValue: configurationService },
      ],
    }).compile();

    backend = module.get<DsparkBackend>(DsparkBackend);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DSPARK_URL;
  });

  // ─── Health check ───────────────────────────────────────────────
  //
  // Probes GET /health, NOT GET /v1/models the way VllmBackend does. On mlx-dspark /v1/models is
  // both API-key-gated and readiness-gated (503 with nothing loaded), so a `serve --no-model`
  // server — the posture the Hub asks operators for — would read as down. These tests pin that.

  describe('healthCheck', () => {
    it('probes /health, not /v1/models', async () => {
      const get = vi.fn().mockResolvedValue({ data: { status: 'ok', model: 'Qwen3-8B-8bit', target: TARGET } });
      (axios.get as never) = get;

      await backend.healthCheck();

      expect(get).toHaveBeenCalledWith('http://127.0.0.1:8080/health', expect.anything());
      expect(get.mock.calls.every(([url]) => !String(url).includes('/v1/models'))).toBe(true);
    });

    it('reports the FULL repo id from `target`, not the short `model` display id', async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({
        data: { status: 'ok', model: 'Qwen3-8B-8bit', target: TARGET },
      });

      const health = await backend.healthCheck();

      // `modelsLoaded` is compared against a catalog `backendModelId`, which is the repo id.
      // Reporting `model` here would make isModelLoaded() permanently false.
      expect(health).toEqual({ running: true, healthy: true, modelsLoaded: [TARGET] });
    });

    it.each(['no_model', 'loading'] as const)('treats status=%s as running and healthy with no models loaded', async (status) => {
      (axios.get as never) = vi.fn().mockResolvedValue({ data: { status, model: null, target: null } });

      const health = await backend.healthCheck();

      // A server started with --no-model is up and correctly configured; it just has nothing
      // resident yet. Reporting it as down would make onboarding refuse to continue.
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toEqual([]);
    });

    it('reports unreachable when the probe rejects', async () => {
      (axios.get as never) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const health = await backend.healthCheck();

      expect(health).toEqual({ running: false, healthy: false, modelsLoaded: [], error: 'ECONNREFUSED' });
    });

    it('probes an override URL without persisting it', async () => {
      const get = vi.fn().mockResolvedValue({ data: { status: 'no_model' } });
      (axios.get as never) = get;

      await backend.healthCheck('http://192.168.1.50:8080/v1/');

      expect(get).toHaveBeenCalledWith('http://192.168.1.50:8080/health', expect.anything());
    });
  });

  // ─── Base URL resolution ────────────────────────────────────────

  describe('getBaseUrl', () => {
    it('prefers the saved Settings URL over DSPARK_URL over the loopback default', () => {
      expect(backend.getBaseUrl()).toBe('http://127.0.0.1:8080');

      process.env.DSPARK_URL = 'http://10.0.0.5:8080';
      expect(backend.getBaseUrl()).toBe('http://10.0.0.5:8080');

      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: null,
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
        preferredVllmUrl: null,
        preferredDsparkUrl: 'http://192.168.1.50:8080/v1',
      });
      expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8080');
    });
  });

  describe('normalizeDsparkBaseUrl', () => {
    it('strips a trailing slash and the /v1 suffix an operator pastes from a client config', () => {
      expect(normalizeDsparkBaseUrl('http://host.docker.internal:8080/v1/')).toBe('http://host.docker.internal:8080');
      expect(normalizeDsparkBaseUrl('  http://host:8080/  ')).toBe('http://host:8080');
    });
  });

  describe('resolveDsparkProbeUrl', () => {
    it('rewrites loopback to host.docker.internal ONLY inside the Hub container', () => {
      expect(resolveDsparkProbeUrl('http://localhost:8080/v1', true)).toBe('http://host.docker.internal:8080');
      expect(resolveDsparkProbeUrl('http://127.0.0.1:8080', true)).toBe('http://host.docker.internal:8080');
      expect(resolveDsparkProbeUrl('http://localhost:8080/v1', false)).toBe('http://localhost:8080');
    });

    it('leaves a remote host alone — a Mac serving a Hub on another box must keep working', () => {
      expect(resolveDsparkProbeUrl('http://192.168.1.50:8080', true)).toBe('http://192.168.1.50:8080');
    });
  });

  // ─── Model load / unload ────────────────────────────────────────

  describe('loadModel', () => {
    it('pins confidence_threshold and kv_bits to 0 on every load — the losslessness guard', async () => {
      const post = vi.fn().mockResolvedValue({ data: { ready: true, loading: false, model: 'Qwen3-8B-8bit', error: null } });
      (axios.post as never) = post;

      await backend.loadModel(TARGET);

      // Omitting either lets mlx-dspark re-resolve the pair's measured defaults, which can ship a
      // non-zero acceptance threshold or a quantized KV cache — both make output diverge from
      // plain decoding with nothing in the Hub UI to say so.
      expect(post).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/admin/load',
        { model: TARGET, confidence_threshold: 0, kv_bits: 0 },
        expect.anything(),
      );
    });

    it('throws when the server answers 200 but never became ready', async () => {
      (axios.post as never) = vi.fn().mockResolvedValue({ data: { ready: false, loading: false, model: null, error: 'out of memory' } });

      await expect(backend.loadModel(TARGET)).rejects.toThrow(/out of memory/);
    });

    it('ignores an embedding load — mlx-dspark serves no /v1/embeddings route', async () => {
      const post = vi.fn();
      (axios.post as never) = post;

      await backend.loadModel('nomic-embed-text', { embedding: true });

      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('unloadModel', () => {
    it('POSTs /admin/unload with an empty body', async () => {
      const post = vi.fn().mockResolvedValue({ data: { ready: false, loading: false, model: null, error: null } });
      (axios.post as never) = post;

      await backend.unloadModel(TARGET);

      expect(post).toHaveBeenCalledWith('http://127.0.0.1:8080/admin/unload', {}, expect.anything());
    });
  });

  describe('isModelLoaded', () => {
    it('matches the catalog backendModelId exactly against /health.target', async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({ data: { status: 'ok', model: 'Qwen3-8B-8bit', target: TARGET } });

      await expect(backend.isModelLoaded(TARGET)).resolves.toBe(true);
      await expect(backend.isModelLoaded('mlx-community/Qwen3-4B-8bit')).resolves.toBe(false);
      // The short display id must NOT match — it is not what the catalog stores.
      await expect(backend.isModelLoaded('Qwen3-8B-8bit')).resolves.toBe(false);
    });
  });

  // ─── Pull progress ──────────────────────────────────────────────

  describe('pullModel', () => {
    it('emits byte progress polled from /health while /admin/load blocks', async () => {
      let resolveLoad: (v: unknown) => void = () => {};
      (axios.post as never) = vi.fn().mockReturnValue(new Promise((resolve) => (resolveLoad = resolve)));
      (axios.get as never) = vi.fn().mockResolvedValue({
        data: { status: 'loading', download: { repo: TARGET, bytes_done: 5_000_000_000, bytes_total: 10_000_000_000 } },
      });

      const progress: { status: string; percent: number; completed?: number; total?: number }[] = [];
      const pull = backend.pullModel(TARGET, (p) => progress.push(p));

      // Let the poll interval fire at least once, then complete the load.
      await vi.waitFor(() => expect(progress.some((p) => p.percent === 50)).toBe(true), { timeout: 3000 });
      resolveLoad({ data: { ready: true, loading: false, model: 'Qwen3-8B-8bit', error: null } });
      await pull;

      const byteTick = progress.find((p) => p.percent === 50);
      expect(byteTick).toMatchObject({ completed: 5_000_000_000, total: 10_000_000_000 });
      expect(progress.at(-1)).toEqual({ status: 'success', percent: 100 });
    });

    it('reports percent 0 — not a fabricated number — when bytes_total is unknown', async () => {
      let resolveLoad: (v: unknown) => void = () => {};
      (axios.post as never) = vi.fn().mockReturnValue(new Promise((resolve) => (resolveLoad = resolve)));
      // bytes_total comes from a best-effort Hugging Face metadata call whose exception mlx-dspark
      // swallows, so null is a real, reachable state.
      (axios.get as never) = vi.fn().mockResolvedValue({
        data: { status: 'loading', download: { repo: TARGET, bytes_done: 5_000_000_000, bytes_total: null } },
      });

      const progress: { status: string; percent: number; total?: number }[] = [];
      const pull = backend.pullModel(TARGET, (p) => progress.push(p));

      await vi.waitFor(() => expect(progress.some((p) => p.total === undefined && p.status.includes('size unknown'))).toBe(true), {
        timeout: 3000,
      });
      resolveLoad({ data: { ready: true, loading: false, model: 'Qwen3-8B-8bit', error: null } });
      await pull;

      const tick = progress.find((p) => p.status.includes('size unknown'));
      expect(tick?.percent).toBe(0);
      expect(tick?.total).toBeUndefined();
    });

    it('surfaces a 501 as actionable guidance rather than a bare HTTP error', async () => {
      const err = Object.assign(new Error('Request failed with status code 501'), {
        isAxiosError: true,
        response: { status: 501, data: { error: 'this server was not started with hot-swap support' } },
      });
      (axios.post as never) = vi.fn().mockRejectedValue(err);
      (axios.get as never) = vi.fn().mockResolvedValue({ data: { status: 'no_model' } });
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

      await expect(backend.pullModel(TARGET)).rejects.toThrow(/serve --no-model/);
    });
  });

  // ─── No Docker path ─────────────────────────────────────────────

  describe('deployment', () => {
    it('declines a Docker image outright', () => {
      expect(() => backend.getDockerImage()).toThrow(/no Docker image/);
    });

    it('declines compose config for every vendor — Metal has no Docker path at all', () => {
      // Unlike VllmBackend, which deploys a CUDA image on nvidia and only declines apple/amd.
      for (const vendor of ['nvidia', 'amd', 'apple', 'intel', 'none']) {
        expect(() => backend.getComposeConfig(vendor)).toThrow(/no Docker path on any platform/);
      }
    });
  });

  describe('buildDsparkRemediation', () => {
    it('suggests pip and --no-model on Apple Silicon, never Homebrew', () => {
      const { command, hint } = buildDsparkRemediation(true);

      expect(command).toContain('--no-model');
      expect(hint).toContain('pip install mlx-dspark');
      // The Homebrew cask installs the Mac APP, not the engine the Hub talks to.
      expect(hint).not.toMatch(/brew/i);
    });

    it('says plainly that the wheel installs but cannot run off Apple Silicon', () => {
      const { hint } = buildDsparkRemediation(false);

      expect(hint).toMatch(/only on Apple Silicon/i);
      expect(hint).toMatch(/fail at\s+runtime|fail at runtime/i);
    });
  });
});
