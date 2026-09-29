import { Test, type TestingModule } from '@nestjs/testing';
import { LemonadeBackend } from '../backends/lemonade.backend';
import type { DeviceGroupProbe } from '../backends/amd-device-groups.util';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

/**
 * A Strix Halo node: only `card1` and `renderD128` exist, the render group is GID 990 and
 * video is 44. Naming the groups instead would resolve `render` to 109 inside the container.
 */
const strixHaloProbe: DeviceGroupProbe = {
  readdirSync: () => ['by-path', 'card1', 'renderD128'],
  statSync: (path: string) => {
    if (path === '/dev/kfd' || path === '/dev/dri/renderD128') return { gid: 990 };
    if (path === '/dev/dri/card1') return { gid: 44 };
    throw new Error(`ENOENT: ${path}`);
  },
};

/** Generating the config away from the GPU host: nothing under /dev to stat. */
const noGpuProbe: DeviceGroupProbe = {
  readdirSync: () => {
    throw new Error('ENOENT: /dev/dri');
  },
  statSync: (path: string) => {
    throw new Error(`ENOENT: ${path}`);
  },
};

describe('LemonadeBackend', () => {
  let backend: LemonadeBackend;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [LemonadeBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<LemonadeBackend>(LemonadeBackend);
  });

  // ─── S-BL-2.3: Health Check ─────────────────────────────────────

  describe('Health check (BL-2)', () => {
    it('S-BL-2.3: SHALL check health via GET /v1/health', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v1/health')) return Promise.resolve({ status: 200 });
        if (url.includes('/v1/models')) return Promise.resolve({ data: { data: [{ id: 'kokoro-v1' }] } });
        return Promise.resolve({ data: {} });
      });

      const health = await backend.healthCheck();

      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
    });

    it('should report unhealthy on failure', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  // ─── NPU Detection ─────────────────────────────────────────────────

  describe('NPU detection (HW-4)', () => {
    it('S-HW-4.1: SHALL detect NPU via Lemonade system-info', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { npu: { available: true, model: 'XDNA2' } },
      });

      const npu = await backend.detectNpu();

      expect(npu.available).toBe(true);
      expect(npu.model).toBe('XDNA2');
    });

    it('S-HW-4.2: SHALL report unavailable when Lemonade not running', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const npu = await backend.detectNpu();

      expect(npu.available).toBe(false);
    });
  });

  describe('Model lifecycle', () => {
    it('loads through Lemonade’s documented /v1/load endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.loadModel('Qwen3-8B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/load', { model_name: 'Qwen3-8B-GGUF' }, { timeout: 120000 });
    });

    it('unloads through Lemonade’s documented /v1/unload endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.unloadModel('Qwen3-8B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/unload', { model_name: 'Qwen3-8B-GGUF' }, { timeout: 30000 });
    });
  });

  describe('Compose config', () => {
    it('should include AMD devices', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });
      expect(config.devices).toContain('/dev/kfd');
    });

    it('adds numeric host GIDs derived from the device nodes it mounts', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // 990 owns /dev/kfd and renderD128, 44 owns card1 — sorted and de-duplicated.
      expect(config.group_add).toEqual(['44', '990']);
    });

    it('never names a group, which would resolve against the container /etc/group', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // The original defect: `render` is GID 109 in the container and 990 on these hosts, so
      // the container joined a group granting nothing and every GPU open failed with EACCES.
      expect(config.group_add).not.toContain('render');
      expect(config.group_add).not.toContain('video');
      expect(JSON.stringify(config)).not.toMatch(/"(render|video)"/);
    });

    it('honours explicitly supplied group IDs without probing /dev', () => {
      const probe = { ...noGpuProbe };
      const config = backend.getComposeConfig('amd', { groupIds: [44, 992], deviceProbe: probe });

      expect(config.group_add).toEqual(['44', '992']);
    });

    it('still emits a deployable AMD config when no GIDs can be derived', () => {
      // Lemonade is not GPU-only — it also serves on CPU and the Ryzen AI NPU — so unlike
      // Lucebox it degrades rather than throwing. It must still never fall back to names.
      const config = backend.getComposeConfig('amd', { deviceProbe: noGpuProbe });

      expect(config.devices).toEqual(['/dev/kfd', '/dev/dri']);
      expect(config).not.toHaveProperty('group_add');
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('omits group_add'));
    });

    it('leaves the non-AMD branches without device permissions', () => {
      for (const vendor of ['nvidia', 'none']) {
        const config = backend.getComposeConfig(vendor, { deviceProbe: strixHaloProbe });

        expect(config).not.toHaveProperty('group_add');
        expect(config).not.toHaveProperty('devices');
      }
    });
  });

  describe('Configuration & Auth', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    it('resolves getBaseUrl from LEMONADE_URL or default', () => {
      delete process.env.LEMONADE_URL;
      expect(backend.getBaseUrl()).toBe('http://ci-hub-lemonade:13305');

      process.env.LEMONADE_URL = 'http://127.0.0.1:13305';
      expect(backend.getBaseUrl()).toBe('http://127.0.0.1:13305');
    });

    it('returns trimmed getApiKey from LEMONADE_API_KEY or undefined', () => {
      delete process.env.LEMONADE_API_KEY;
      expect(backend.getApiKey()).toBeUndefined();

      process.env.LEMONADE_API_KEY = '  lemon-secret-123  ';
      expect(backend.getApiKey()).toBe('lemon-secret-123');
    });

    it('includes Authorization header in requests when LEMONADE_API_KEY is set', async () => {
      process.env.LEMONADE_API_KEY = 'lemon-secret-123';
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v1/health')) return Promise.resolve({ status: 200 });
        if (url.includes('/v1/models')) return Promise.resolve({ data: { data: [{ id: 'm1' }] } });
        return Promise.resolve({ data: {} });
      });

      await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/health',
        expect.objectContaining({
          headers: { Authorization: 'Bearer lemon-secret-123' },
        }),
      );
    });
  });
});
