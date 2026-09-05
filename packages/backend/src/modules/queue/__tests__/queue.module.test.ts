import { describe, expect, it } from 'vitest';
import { scopedQueueName } from '../queue.module';

describe('scopedQueueName', () => {
  it('preserves production queue names when no scope is configured', () => {
    expect(scopedQueueName('app-events-queue', undefined)).toBe('app-events-queue');
    expect(scopedQueueName('repo-queue', '   ')).toBe('repo-queue');
  });

  it('isolates every worker queue behind a trimmed test scope', () => {
    expect(scopedQueueName('app-events-queue', ' ftue-e2e ')).toBe('ftue-e2e-app-events-queue');
    expect(scopedQueueName('repo-queue', 'ftue-e2e')).toBe('ftue-e2e-repo-queue');
    expect(scopedQueueName('system-events-queue', 'ftue-e2e')).toBe('ftue-e2e-system-events-queue');
  });
});
