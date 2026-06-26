import { describe, expect, it } from 'vitest';
import { managedAppStatusFromSummary, summarizeManagedAppContainers } from '../managed-app-containers';

describe('managed-app-containers', () => {
  it('summarizes running and clean-exit containers', () => {
    expect(
      summarizeManagedAppContainers([
        { State: 'running', Status: 'Up 5 seconds' },
        { State: 'exited', Status: 'Exited (0) 1 second ago' },
      ]),
    ).toEqual({ total: 2, running: 1, exitZero: 1 });
  });

  it('maps summaries to app status like status sync', () => {
    expect(managedAppStatusFromSummary({ total: 0, running: 0, exitZero: 0 })).toBe('missing');
    expect(managedAppStatusFromSummary({ total: 2, running: 2, exitZero: 0 })).toBe('running');
    expect(managedAppStatusFromSummary({ total: 2, running: 1, exitZero: 1 })).toBe('running');
    expect(managedAppStatusFromSummary({ total: 2, running: 1, exitZero: 0 })).toBe('stopped');
  });
});
