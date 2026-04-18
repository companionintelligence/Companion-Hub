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

    if (!state.ready) {
      return indicator.down({
        state: state.status,
        ready: state.ready,
        attempts: state.attempts,
        ...(state.lastError ? { lastError: state.lastError } : {}),
      });
    }

    return indicator.up({
      state: state.status,
      ready: state.ready,
      attempts: state.attempts,
    });
  }
}
