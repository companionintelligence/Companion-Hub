/**
 * When a lifecycle operation has to be over: the moment the service that queued it stops waiting
 * for its reply (`appEventsRpcTimeoutMs`, counted from when the operation was queued, so time spent
 * waiting for a free worker counts too). Past it, the service decides the outcome without the
 * worker, while the worker may still be changing the app.
 *
 * ⚠ ONE BUDGET FOR EVERY STEP. Each step of an update had a limit of its own (an image pull up to
 * 45 minutes, the health wait up to 15, a privileged copy up to 30). Together they outlasted the
 * 45 minutes the service waits. A step now asks this object how long it may take, so the steps share
 * the one budget. An operation that can be undone keeps the end of it free for that
 * (`remainingBeforeMs`).
 */
export class OperationDeadline {
  constructor(
    /** Epoch ms by which the operation must have replied. */
    readonly endsAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds left before the reply is due; 0 once it has passed. */
  remainingMs(): number {
    return Math.max(0, this.endsAt - this.now());
  }

  /** Milliseconds left for work that must end `reserveMs` before the reply is due; 0 once that has passed. */
  remainingBeforeMs(reserveMs: number): number {
    return Math.max(0, this.endsAt - reserveMs - this.now());
  }
}
