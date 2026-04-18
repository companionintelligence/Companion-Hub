import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { HealthIndicatorService } from '@nestjs/terminus';
import { QueueFactory } from '../queue.factory';
import { QueueHealthIndicator } from '../queue.health';

describe('QueueHealthIndicator', () => {
  it('reports degraded queue state details when RabbitMQ is unavailable', async () => {
    const queueFactory = mock<QueueFactory>();
    const healthIndicatorService = mock<HealthIndicatorService>();
    const down = vi.fn((details) => ({ queue: { status: 'down', ...details } }));

    healthIndicatorService.check.mockReturnValue({ down, up: vi.fn() } as never);
    queueFactory.getConnectionState.mockReturnValue({
      status: 'degraded',
      ready: false,
      attempts: 2,
      lastError: 'socket closed',
    });

    const indicator = new QueueHealthIndicator(queueFactory, healthIndicatorService);
    const result = await indicator.isHealthy('queue');

    expect(down).toHaveBeenCalledWith({
      state: 'degraded',
      ready: false,
      attempts: 2,
      lastError: 'socket closed',
    });
    expect(result).toEqual({
      queue: {
        status: 'down',
        state: 'degraded',
        ready: false,
        attempts: 2,
        lastError: 'socket closed',
      },
    });
  });

  it('reports ready queue state details when RabbitMQ is healthy', async () => {
    const queueFactory = mock<QueueFactory>();
    const healthIndicatorService = mock<HealthIndicatorService>();
    const up = vi.fn((details) => ({ queue: { status: 'up', ...details } }));

    healthIndicatorService.check.mockReturnValue({ down: vi.fn(), up } as never);
    queueFactory.getConnectionState.mockReturnValue({
      status: 'ready',
      ready: true,
      attempts: 0,
    });

    const indicator = new QueueHealthIndicator(queueFactory, healthIndicatorService);
    const result = await indicator.isHealthy('queue');

    expect(up).toHaveBeenCalledWith({
      state: 'ready',
      ready: true,
      attempts: 0,
    });
    expect(result).toEqual({
      queue: {
        status: 'up',
        state: 'ready',
        ready: true,
        attempts: 0,
      },
    });
  });
});
