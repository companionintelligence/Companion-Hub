import { Test, type TestingModule } from '@nestjs/testing';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

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
      const config = backend.getComposeConfig('amd');
      expect(config.devices).toContain('/dev/kfd');
    });
  });
});
