import { DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES } from '@/common/constants';

/**
 * How long the app events queue waits for a command's reply before the publisher gives up: the
 * configured events timeout, never less than an image pull is allowed to take. After that the
 * publisher marks the app as failed or stopped, whatever the worker is still doing.
 */
export function appEventsQueueTimeoutMs(eventsTimeoutMinutes: number | undefined): number {
  const minutes = typeof eventsTimeoutMinutes === 'number' && Number.isFinite(eventsTimeoutMinutes) ? eventsTimeoutMinutes : 0;
  return Math.max(minutes, Number(DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES)) * 60_000;
}

/** Kept back from the queue timeout for what a command does after its last helper and for the reply itself. */
const QUEUE_REPLY_MARGIN_MS = 5 * 60_000;

/** No command gets less than this, whatever the settings say. */
const MIN_BUDGET_MS = 1_000;

/**
 * One time limit for everything slow a single app command runs as root: a restore's delete and
 * extract, a reset's delete, a backup's archive. Each helper used to get 30 minutes of its own, so a
 * restore of a big data folder (delete, then extract) could outlast the queue's 45 minutes. The
 * publisher then marked the app stopped while the worker was still writing its data. The helpers of
 * one command now share this budget, which ends while the queue is still waiting for the reply.
 *
 * `CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS` can only lower the budget, for a Hub that should give up
 * sooner and for testing.
 */
export class AppCommandDeadline {
  private constructor(
    private readonly endsAt: number,
    readonly budgetMs: number,
  ) {}

  /** A budget that starts now and ends {@link QUEUE_REPLY_MARGIN_MS} before the queue stops waiting. */
  static forAppCommand(eventsTimeoutMinutes: number | undefined): AppCommandDeadline {
    let budget = Math.max(MIN_BUDGET_MS, appEventsQueueTimeoutMs(eventsTimeoutMinutes) - QUEUE_REPLY_MARGIN_MS);
    const override = Number(process.env.CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS);

    if (Number.isFinite(override) && override > 0) {
      budget = Math.max(MIN_BUDGET_MS, Math.min(budget, override * 1000));
    }

    return new AppCommandDeadline(Date.now() + budget, budget);
  }

  static after(budgetMs: number): AppCommandDeadline {
    return new AppCommandDeadline(Date.now() + budgetMs, budgetMs);
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs() === 0;
  }

  /** The budget in words, for a message: "40 minutes", "5 seconds". */
  describe(): string {
    const seconds = Math.round(this.budgetMs / 1000);
    return seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
}
