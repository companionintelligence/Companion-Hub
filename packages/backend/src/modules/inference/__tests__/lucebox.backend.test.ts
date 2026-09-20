import { Test, type TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from '../backends/amd-device-groups.util';
import {
  assertLuceboxImageSupportsArch,
  isRocmLegacyBrokenArch,
  LUCEBOX_CUDA_IMAGE,
  LUCEBOX_MODELS_MOUNT,
  LUCEBOX_ROCM_IMAGE,
  LUCEBOX_ROCM_LEGACY_IMAGE,
  LuceboxBackend,
  normalizeLuceboxBaseUrl,
  resolveLuceboxProbeUrl,
  resolveLuceboxRocmImage,
} from '../backends/lucebox.backend';

vi.mock('axios');

/** A Strix Halo node: only `renderD128`, `card1`, render GID 990, video GID 44. */
const strixHaloProbe: DeviceGroupProbe = {
  readdirSync: () => ['by-path', 'card1', 'renderD128'],
  statSync: (path: string) => {
    if (path === '/dev/kfd' || path === '/dev/dri/renderD128') return { gid: 990 };
    if (path === '/dev/dri/card1') return { gid: 44 };
    throw new Error(`ENOENT: ${path}`);
  },
};

const noGpuProbe: DeviceGroupProbe = {
  readdirSync: () => {
    throw new Error('ENOENT: /dev/dri');
  },
  statSync: (path: string) => {
    throw new Error(`ENOENT: ${path}`);
  },
};

describe('LuceboxBackend', () => {
  let backend: LuceboxBackend;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [LuceboxBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<LuceboxBackend>(LuceboxBackend);
  });

  describe('Health check', () => {
    it('checks Lucebox health and discovers its startup-configured model', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'dflash' }] } });
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenNthCalledWith(1, expect.stringContaining('/health'), expect.any(Object));
      expect(axios.get).toHaveBeenNthCalledWith(2, expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health).toEqual({ running: true, healthy: true, modelsLoaded: ['dflash'] });
    });

    it('is unhealthy when /health answers but no model is loaded', async () => {
      // A Lucebox whose target GGUF is missing still serves /health, then fails every
      // completion. Reachable is not serving.
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [] } });
      });

      const health = await backend.healthCheck();

      expect(health.running).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.modelsLoaded).toEqual([]);
      expect(health.error).toMatch(/no loaded model/i);
    });

    it('yields the server to vLLM when /v1/models says it is vLLM — vLLM answers /health too, on the same default port', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'Qwen/Qwen3.5-9B', owned_by: 'vllm' }] } });
      });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain("the vllm backend's server, not lucebox's");
      expect(health.error).toContain('SPECULATIVE_INFERENCE_URL');
      await expect(backend.listModels()).resolves.toEqual([]);
    });

    it('reports an unavailable server when the health probe fails', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(backend.healthCheck()).resolves.toMatchObject({
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: 'Connection refused',
      });
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('does not report a model as loaded when the server has none', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [] } });
      });

      await expect(backend.isModelLoaded('dflash')).resolves.toBe(false);
    });
  });

  describe('URL resolution', () => {
    it('strips /v1 and trailing slashes', () => {
      expect(normalizeLuceboxBaseUrl(' http://localhost:8000/v1/ ')).toBe('http://localhost:8000');
    });

    it('rewrites loopback to the Docker host only inside the Hub container', () => {
      expect(resolveLuceboxProbeUrl('http://localhost:8000/v1', true)).toBe('http://host.docker.internal:8000');
      expect(resolveLuceboxProbeUrl('http://127.0.0.1:8000', true)).toBe('http://host.docker.internal:8000');
      expect(resolveLuceboxProbeUrl('http://localhost:8000/v1', false)).toBe('http://localhost:8000');
    });
  });

  describe('ROCm image / GPU architecture pairing', () => {
    it('classifies RDNA 3.5 targets as broken on the ROCm 6.4.1 tag', () => {
      expect(isRocmLegacyBrokenArch('gfx1151')).toBe(true);
      expect(isRocmLegacyBrokenArch('GFX1151')).toBe(true);
      expect(isRocmLegacyBrokenArch('gfx1150')).toBe(true);
      expect(isRocmLegacyBrokenArch('gfx1100')).toBe(false);
      expect(isRocmLegacyBrokenArch('gfx942')).toBe(false);
    });

    it('never selects the ROCm 6.4.1 tag, including for an undetected GPU', () => {
      expect(resolveLuceboxRocmImage('gfx1151')).toBe(LUCEBOX_ROCM_IMAGE);
      expect(resolveLuceboxRocmImage('gfx1100')).toBe(LUCEBOX_ROCM_IMAGE);
      expect(resolveLuceboxRocmImage(undefined)).toBe(LUCEBOX_ROCM_IMAGE);
      expect(resolveLuceboxRocmImage('gfx1151')).not.toBe(LUCEBOX_ROCM_LEGACY_IMAGE);
    });

    it('rejects an explicit ROCm 6.4.1 pin on gfx1151', () => {
      expect(() => assertLuceboxImageSupportsArch(LUCEBOX_ROCM_LEGACY_IMAGE, 'gfx1151')).toThrow(/ROCm 6\.4\.1/);
      expect(() => assertLuceboxImageSupportsArch(LUCEBOX_ROCM_LEGACY_IMAGE, 'gfx1151')).toThrow(/rocm-7\.2/);
    });

    it('allows the ROCm 6.4.1 pin on architectures that work with it', () => {
      expect(() => assertLuceboxImageSupportsArch(LUCEBOX_ROCM_LEGACY_IMAGE, 'gfx1100')).not.toThrow();
      expect(() => assertLuceboxImageSupportsArch(LUCEBOX_ROCM_IMAGE, 'gfx1151')).not.toThrow();
      expect(() => assertLuceboxImageSupportsArch(LUCEBOX_ROCM_LEGACY_IMAGE, undefined)).not.toThrow();
    });

    it('refuses a compose config that pins the segfaulting image for gfx1151', () => {
      expect(() =>
        backend.getComposeConfig('amd', {
          gpuArch: 'gfx1151',
          image: LUCEBOX_ROCM_LEGACY_IMAGE,
          deviceProbe: strixHaloProbe,
        }),
      ).toThrow(/hipMemcpy/);
    });
  });

  describe('AMD device group IDs', () => {
    it('derives numeric host GIDs by statting the device nodes it mounts', () => {
      expect(resolveAmdDeviceGroupIds(strixHaloProbe)).toEqual([44, 990]);
    });

    it('tolerates hosts with card0 instead of card1 and no renderD129', () => {
      const betaMaxProbe: DeviceGroupProbe = {
        readdirSync: () => ['by-path', 'card0', 'renderD128'],
        statSync: (path: string) => {
          if (path === '/dev/kfd' || path === '/dev/dri/renderD128') return { gid: 990 };
          if (path === '/dev/dri/card0') return { gid: 44 };
          throw new Error(`ENOENT: ${path}`);
        },
      };

      expect(resolveAmdDeviceGroupIds(betaMaxProbe)).toEqual([44, 990]);
    });

    it('returns nothing when the host has no GPU device nodes', () => {
      expect(resolveAmdDeviceGroupIds(noGpuProbe)).toEqual([]);
    });
  });

  describe('Compose config', () => {
    it('selects the CUDA image and NVIDIA runtime', () => {
      const config = backend.getComposeConfig('nvidia');

      expect(config.image).toBe(LUCEBOX_CUDA_IMAGE);
      expect(config.runtime).toBe('nvidia');
    });

    it('selects the ROCm 7.2 image and device mounts for AMD', () => {
      const config = backend.getComposeConfig('amd', { gpuArch: 'gfx1151', deviceProbe: strixHaloProbe });

      expect(config.image).toBe(LUCEBOX_ROCM_IMAGE);
      expect(config.devices).toEqual(['/dev/kfd', '/dev/dri']);
      expect(config.security_opt).toEqual(['seccomp=unconfined']);
    });

    it('adds numeric host GIDs, never group names', () => {
      const config = backend.getComposeConfig('amd', { gpuArch: 'gfx1151', deviceProbe: strixHaloProbe });

      // Names would resolve against the container's /etc/group (render = 109), not the host's 990.
      expect(config.group_add).toEqual(['44', '990']);
      expect(config.group_add).not.toContain('render');
      expect(config.group_add).not.toContain('video');
    });

    it('refuses an AMD config when the GPU device GIDs cannot be derived', () => {
      expect(() => backend.getComposeConfig('amd', { gpuArch: 'gfx1151', deviceProbe: noGpuProbe })).toThrow(/GIDs/);
    });

    it('honours explicitly supplied group IDs without probing', () => {
      const config = backend.getComposeConfig('amd', { gpuArch: 'gfx1151', groupIds: [44, 992], deviceProbe: noGpuProbe });

      expect(config.group_add).toEqual(['44', '992']);
    });

    it('bind-mounts the host models directory read-only rather than a named volume', () => {
      const config = backend.getComposeConfig('nvidia');

      // A named volume starts empty and the entrypoint dies with no target GGUF.
      expect(config.volumes).toEqual([`/opt/lucebox-models:${LUCEBOX_MODELS_MOUNT}:ro`]);
      expect(config.volumes).not.toEqual([`lucebox-models:${LUCEBOX_MODELS_MOUNT}`]);
    });

    it('accepts a custom host models directory', () => {
      const config = backend.getComposeConfig('nvidia', { modelsDir: '/srv/weights' });

      expect(config.volumes).toEqual([`/srv/weights:${LUCEBOX_MODELS_MOUNT}:ro`]);
    });

    it('publishes on loopback instead of every interface', () => {
      const config = backend.getComposeConfig('nvidia');

      expect(config.ports).toEqual(['127.0.0.1:8000:8080']);
      expect(config.ports).not.toEqual(['8000:8080']);
    });

    it('publishes on a supplied bind address and port', () => {
      const config = backend.getComposeConfig('amd', {
        gpuArch: 'gfx1151',
        deviceProbe: strixHaloProbe,
        bindAddress: '100.114.164.27',
        hostPort: 8216,
      });

      expect(config.ports).toEqual(['100.114.164.27:8216:8080']);
    });

    it('sets the model environment the entrypoint requires', () => {
      const config = backend.getComposeConfig('amd', { gpuArch: 'gfx1151', deviceProbe: strixHaloProbe });
      const environment = config.environment as Record<string, string>;

      expect(environment.DFLASH_TARGET).toBe(`${LUCEBOX_MODELS_MOUNT}/Qwen3.6-27B-Q4_K_M.gguf`);
      expect(environment.DFLASH_DRAFT).toBe(`${LUCEBOX_MODELS_MOUNT}/drafter/dflash-draft-3.6-q4_k_m.gguf`);
      expect(environment.DFLASH27B_DRAFT_SWA).toBe('2048');
      expect(environment.DFLASH_MAX_CTX).toBe('16384');
      expect(environment.DFLASH_CACHE_TYPE_K).toBe('q8_0');
      expect(environment.DFLASH_CACHE_TYPE_V).toBe('q8_0');
      expect(environment.DFLASH_MODEL_NAME).toBe('qwen36-27b');
      expect(environment.DFLASH_PORT).toBe('8080');
      // Container-internal bind: the `ports` mapping is what limits host exposure.
      expect(environment.DFLASH_HOST).toBe('0.0.0.0');
    });

    it('points the model environment at custom filenames', () => {
      const config = backend.getComposeConfig('nvidia', {
        targetModel: 'Custom-Target.gguf',
        draftModel: 'drafter/custom-draft.gguf',
      });
      const environment = config.environment as Record<string, string>;

      expect(environment.DFLASH_TARGET).toBe(`${LUCEBOX_MODELS_MOUNT}/Custom-Target.gguf`);
      expect(environment.DFLASH_DRAFT).toBe(`${LUCEBOX_MODELS_MOUNT}/drafter/custom-draft.gguf`);
    });
  });

  it('does not pretend that startup-configured models can be pulled', async () => {
    const progress = vi.fn();

    await backend.pullModel('dflash', progress);

    expect(progress).toHaveBeenCalledWith({ status: 'Speculative inference models are configured when the server starts', percent: 100 });
    expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('no pull was requested'));
  });
});
