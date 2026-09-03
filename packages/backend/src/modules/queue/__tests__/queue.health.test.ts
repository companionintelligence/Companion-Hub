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

    // Flag is already down, so the probe is skipped (no point paying the round trip).
    expect(queueFactory.probeConnection).not.toHaveBeenCalled();
    expect(down).toHaveBeenCalledWith({
      state: 'degraded',
      ready: false,
      probe: 'skipped',
      attempts: 2,
      lastError: 'socket closed',
    });
    expect(result).toEqual({
      queue: {
        status: 'down',
        state: 'degraded',
        ready: false,
        probe: 'skipped',
        attempts: 2,
        lastError: 'socket closed',
      },
    });
  });

  it('reports ready when the flag is up and the channel probe succeeds', async () => {
    const queueFactory = mock<QueueFactory>();
    const healthIndicatorService = mock<HealthIndicatorService>();
    const up = vi.fn((details) => ({ queue: { status: 'up', ...details } }));

    healthIndicatorService.check.mockReturnValue({ down: vi.fn(), up } as never);
    queueFactory.getConnectionState.mockReturnValue({
      status: 'ready',
      ready: true,
      attempts: 0,
    });
    queueFactory.probeConnection.mockResolvedValue(true);

    const indicator = new QueueHealthIndicator(queueFactory, healthIndicatorService);
    const result = await indicator.isHealthy('queue');

    expect(up).toHaveBeenCalledWith({
      state: 'ready',
      ready: true,
      probe: 'ok',
      attempts: 0,
    });
    expect(result).toEqual({
      queue: {
        status: 'up',
        state: 'ready',
        ready: true,
        probe: 'ok',
        attempts: 0,
      },
    });
  });

  it('reports down when the flag is up but the channel probe fails (false-ready)', async () => {
    const queueFactory = mock<QueueFactory>();
    const healthIndicatorService = mock<HealthIndicatorService>();
    const down = vi.fn((details) => ({ queue: { status: 'down', ...details } }));

    healthIndicatorService.check.mockReturnValue({ down, up: vi.fn() } as never);
    queueFactory.getConnectionState.mockReturnValue({
      status: 'ready',
      ready: true,
      attempts: 0,
    });
    // Cached flag says ready, but a real channel can't be opened.
    queueFactory.probeConnection.mockResolvedValue(false);

    const indicator = new QueueHealthIndicator(queueFactory, healthIndicatorService);
    const result = await indicator.isHealthy('queue');

    expect(queueFactory.probeConnection).toHaveBeenCalled();
    expect(down).toHaveBeenCalledWith({
      state: 'ready',
      ready: true,
      probe: 'failed',
      attempts: 0,
    });
    expect(result).toEqual({
      queue: {
        status: 'down',
        state: 'ready',
        ready: true,
        probe: 'failed',
        attempts: 0,
      },
    });
  });
});
