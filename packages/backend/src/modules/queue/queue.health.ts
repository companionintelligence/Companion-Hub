import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { QueueFactory } from './queue.factory';

@Injectable()
export class QueueHealthIndicator {
  constructor(
    private readonly queueFactory: QueueFactory,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const state = this.queueFactory.getConnectionState();

    // The cached `ready` flag is necessary but not sufficient — after a RabbitMQ
    // restart the factory can report ready while its channels are bound to a
    // closing connection. Actively probe a channel so this endpoint reflects real
    // liveness; that in turn lets Docker's healthcheck / the desktop supervisor
    // act on the failure (and recover) instead of trusting a stale flag.
    // Skip the probe when the flag is already down — no need to pay the round trip.
    const probe = state.ready ? await this.queueFactory.probeConnection() : false;

    if (!state.ready || !probe) {
      return indicator.down({
        state: state.status,
        ready: state.ready,
        probe: state.ready ? 'failed' : 'skipped',
        attempts: state.attempts,
        ...(state.lastError ? { lastError: state.lastError } : {}),
      });
    }

    return indicator.up({
      state: state.status,
      ready: state.ready,
      probe: 'ok',
      attempts: state.attempts,
    });
  }
}
