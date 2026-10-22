import { describe, expect, it } from 'vitest';
import { OperationDeadline } from '../operation-deadline';

describe('OperationDeadline', () => {
  const MIN = 60_000;
  let now = 0;
  const deadline = new OperationDeadline(45 * MIN, () => now);

  it('says how long is left before the reply is due and nothing once it has passed', () => {
    now = 30 * MIN;
    expect(deadline.remainingMs()).toBe(15 * MIN);

    now = 50 * MIN;
    expect(deadline.remainingMs()).toBe(0);
  });

  it('keeps a reserve free at the end, for undoing the work', () => {
    now = 30 * MIN;
    expect(deadline.remainingBeforeMs(10 * MIN)).toBe(5 * MIN);

    now = 40 * MIN;
    expect(deadline.remainingBeforeMs(10 * MIN)).toBe(0);
    // The reserve itself is still there for the rollback.
    expect(deadline.remainingMs()).toBe(5 * MIN);
  });
});
