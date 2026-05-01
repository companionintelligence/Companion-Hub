import { Test, type TestingModule } from '@nestjs/testing';
import { VllmBackend } from '../backends/vllm.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

describe('VllmBackend', () => {
  let backend: VllmBackend;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [VllmBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<VllmBackend>(VllmBackend);
  });

  // ─── S-BL-2.2: Health Check ─────────────────────────────────────

  describe('Health check (BL-2)', () => {
    it('S-BL-2.2: SHALL check health via GET /v1/models', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { data: [{ id: 'llama-70b' }] },
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toContain('llama-70b');
    });

    it('should report unhealthy on failure', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  describe('Compose config', () => {
    it('should include GPU config for NVIDIA', () => {
      const config = backend.getComposeConfig('nvidia');
      expect(config.runtime).toBe('nvidia');
    });

    it('should include AMD devices', () => {
      const config = backend.getComposeConfig('amd');
      expect(config.devices).toContain('/dev/kfd');
    });
  });
});
