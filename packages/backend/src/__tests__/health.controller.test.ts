import { APP_DATA_DIR } from '@/common/constants';
import { HealthController } from '@/core/health/health.controller';
import { QueueHealthIndicator } from '@/modules/queue/queue.health';
import { HealthCheckService } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn(),
        readdir: vi.fn(),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
      },
    },
    promises: {
      ...actual.promises,
      access: vi.fn(),
      readdir: vi.fn(),
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    },
  };
});

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: mock<HealthCheckService>() },
        { provide: QueueHealthIndicator, useValue: mock<QueueHealthIndicator>() },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('live should return ok immediately', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  describe('check', () => {
    it('should delegate readiness to terminus with a timeout guard', async () => {
      const healthCheckService = mock<HealthCheckService>();
      const queueHealthIndicator = mock<QueueHealthIndicator>();
      healthCheckService.check.mockResolvedValue({ status: 'ok' } as any);

      const moduleRef = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: HealthCheckService, useValue: healthCheckService },
          { provide: QueueHealthIndicator, useValue: queueHealthIndicator },
        ],
      }).compile();

      const controller = moduleRef.get(HealthController);
      const result = await controller.check();

      expect(result).toEqual({ status: 'ok' });
      expect(healthCheckService.check).toHaveBeenCalledOnce();
    });

    it('should reject with ServiceUnavailableException when readiness check times out', async () => {
      vi.useFakeTimers();

      const healthCheckService = mock<HealthCheckService>();
      const queueHealthIndicator = mock<QueueHealthIndicator>();
      healthCheckService.check.mockReturnValue(new Promise(() => {}));

      const moduleRef = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          { provide: HealthCheckService, useValue: healthCheckService },
          { provide: QueueHealthIndicator, useValue: queueHealthIndicator },
        ],
      }).compile();

      const controller = moduleRef.get(HealthController);
      const checkPromise = controller.check();
      const expectation = expect(checkPromise).rejects.toMatchObject({
        message: 'readiness check timed out',
        status: 503,
      });

      await vi.advanceTimersByTimeAsync(4_000);
      await expectation;

      vi.useRealTimers();
    });
  });

  describe('checkDataIntegrity', () => {
    it('should return ok when all directories exist and are writable', async () => {
      vi.mocked(fs.promises.access).mockResolvedValue(undefined);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      const result = await controller.checkDataIntegrity();

      expect(result.ok).toBe(true);
      expect(result.dirs.data.exists).toBe(true);
      expect(result.dirs.data.writable).toBe(true);
      expect(result.dirs.appData.exists).toBe(true);
      expect(result.dirs.appData.writable).toBe(true);
    });

    it('should return not ok when a directory is missing', async () => {
      vi.mocked(fs.promises.access).mockImplementation(async (p: any, _mode?: any) => {
        const pathStr = typeof p === 'string' ? p : p.toString();
        // APP_DATA_DIR doesn't exist
        if (pathStr === APP_DATA_DIR || pathStr.startsWith(APP_DATA_DIR)) {
          throw new Error('ENOENT');
        }
        return undefined;
      });

      const result = await controller.checkDataIntegrity();

      expect(result.ok).toBe(false);
      expect(result.dirs.appData.exists).toBe(false);
    });
  });
});
