import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCommandDeadline, appEventsQueueTimeoutMs } from '../app-command-deadline';

/*
 * The app queue waits at most 45 minutes (or the configured events timeout, if longer) for a command's
 * reply. A restore ran a root delete and a root extract of up to 30 minutes each, so a big one could
 * outlast it: the publisher marked the app stopped while the worker went on writing its data.
 */
describe('AppCommandDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS;
  });

  it('waits as long as the queue does, never less than 45 minutes', () => {
    expect(appEventsQueueTimeoutMs(5)).toBe(45 * 60_000);
    expect(appEventsQueueTimeoutMs(90)).toBe(90 * 60_000);
    expect(appEventsQueueTimeoutMs(undefined)).toBe(45 * 60_000);
    expect(appEventsQueueTimeoutMs(Number.NaN)).toBe(45 * 60_000);
  });

  it('gives a command five minutes less than the queue waits, so its reply still arrives', () => {
    expect(AppCommandDeadline.forAppCommand(5).budgetMs).toBe(40 * 60_000);
    expect(AppCommandDeadline.forAppCommand(90).budgetMs).toBe(85 * 60_000);
  });

  it('counts down from when it was made', () => {
    const deadline = AppCommandDeadline.forAppCommand(5);

    vi.advanceTimersByTime(39 * 60_000);
    expect(deadline.remainingMs()).toBe(60_000);
    expect(deadline.expired).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired).toBe(true);
  });

  it('can be lowered by CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS, never raised', () => {
    process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = '20';
    expect(AppCommandDeadline.forAppCommand(5).budgetMs).toBe(20_000);

    process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = String(24 * 60 * 60);
    expect(AppCommandDeadline.forAppCommand(5).budgetMs).toBe(40 * 60_000);

    process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = 'not a number';
    expect(AppCommandDeadline.forAppCommand(5).budgetMs).toBe(40 * 60_000);
  });

  it('says its budget in words', () => {
    expect(AppCommandDeadline.forAppCommand(5).describe()).toBe('40 minutes');
    expect(AppCommandDeadline.after(60_000).describe()).toBe('1 minute');
    expect(AppCommandDeadline.after(5_000).describe()).toBe('5 seconds');
  });

  // A command waits in the queue before a worker takes it. The publisher's wait runs all the while.
  describe('for a command taken from the queue', () => {
    const MIN = 60_000;

    it('ends five minutes before the reply is due, counted from when the command was queued', () => {
      const enqueuedAt = Date.now();
      vi.advanceTimersByTime(12 * MIN);

      const deadline = AppCommandDeadline.untilReply(enqueuedAt, 45 * MIN);

      expect(deadline.endsAt).toBe(enqueuedAt + 40 * MIN);
      expect(deadline.remainingMs()).toBe(28 * MIN);
    });

    it('keeps a reserve free at its end for undoing the work', () => {
      const deadline = AppCommandDeadline.untilReply(Date.now(), 45 * MIN);
      const work = deadline.withReserve(10 * MIN);

      expect(deadline.remainingBeforeMs(10 * MIN)).toBe(30 * MIN);
      expect(work.remainingMs()).toBe(30 * MIN);

      vi.advanceTimersByTime(35 * MIN);
      expect(work.expired).toBe(true);
      // The reserve itself is still there for the rollback.
      expect(deadline.remainingMs()).toBe(5 * MIN);
    });

    it('is lowered by the helper budget override like any other', () => {
      process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS = '60';

      expect(AppCommandDeadline.untilReply(Date.now(), 45 * MIN).remainingMs()).toBe(MIN);
    });
  });
});
