import { describe, expect, it } from 'vitest';
import { APP_CAME_UP_TIMING, type AppContainerLook, AppCameUpWatch, describeAppServiceFailure, reasonFromLogs } from '../managed-app-containers';

const START = 1_800_000_000_000;

function container(over: Partial<AppContainerLook> & { service: string; state: string }): AppContainerLook {
  return {
    id: over.service,
    containerName: `app-${over.service}-1`,
    exitCode: 0,
    restartCount: 0,
    startedAtMs: START,
    health: null,
    ...over,
  };
}

/** Runs the looks one second apart as the wait does and returns the first answer. */
function watch(lookAt: (elapsedMs: number) => AppContainerLook[]) {
  const appWatch = new AppCameUpWatch(START);
  for (let elapsedMs = 0; elapsedMs <= 120_000; elapsedMs += APP_CAME_UP_TIMING.lookEveryMs) {
    const verdict = appWatch.judge(lookAt(elapsedMs), START + elapsedMs);
    if (verdict.outcome !== 'waiting') {
      return { ...verdict, elapsedMs };
    }
  }
  throw new Error('the watch never answered');
}

describe('AppCameUpWatch', () => {
  it('passes a healthy service once it has run for the window, with no fixed wait beyond that', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running' })]);

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.upAfterMs);
  });

  it('counts the time a container has already been up, so a boot that recreated nothing takes two looks', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running', startedAtMs: START - 86_400_000, restartCount: 7 })]);

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.lookEveryMs);
  });

  it('passes as soon as the health check says healthy', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running', health: 'healthy' })]);

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.lookEveryMs);
  });

  it('does not wait for a slow app whose health check still says starting and does not fail it', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running', health: 'starting' })]);

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.upAfterMs);
  });

  it('fails a crash loop even when the look lands on the moment it reads running', () => {
    // Exits 126 about a second after each start: every other look finds it running.
    const verdict = watch((elapsedMs) => {
      const crashes = Math.floor(elapsedMs / 2000);
      return [
        container({
          service: 'summary-service',
          state: elapsedMs % 2000 === 0 ? 'running' : 'restarting',
          exitCode: elapsedMs % 2000 === 0 ? 0 : 126,
          restartCount: crashes,
          startedAtMs: START + crashes * 2000,
        }),
      ];
    });

    expect(verdict).toMatchObject({
      outcome: 'failed',
      kind: 'restarting',
      containers: [{ service: 'summary-service', exitCode: 126 }],
    });
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.settleWithinMs);
  });

  it('does not take the 0 of a container still created for the exit code of its crash', () => {
    const verdict = watch((elapsedMs) => [
      container({ service: 'web', state: 'running' }),
      elapsedMs === 0
        ? container({ service: 'api', state: 'created', startedAtMs: null })
        : container({ service: 'api', state: 'running', restartCount: Math.floor(elapsedMs / 1000), startedAtMs: START + elapsedMs }),
    ]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'restarting', containers: [{ service: 'api', exitCode: null }] });
  });

  it('fails a crash loop that is restarting at every look, beside a service that is fine', () => {
    const verdict = watch(() => [
      container({ service: 'web', state: 'running' }),
      container({ service: 'summary-service', state: 'restarting', exitCode: 126, restartCount: 4 }),
    ]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'restarting', containers: [{ service: 'summary-service', exitCode: 126 }] });
  });

  it('passes a service that crashes until its database is up and then stays up', () => {
    const verdict = watch((elapsedMs) =>
      elapsedMs < 6000
        ? [container({ service: 'api', state: 'restarting', exitCode: 1, restartCount: Math.floor(elapsedMs / 1000) })]
        : [container({ service: 'api', state: 'running', restartCount: 6, startedAtMs: START + 6000 })],
    );

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(6000 + APP_CAME_UP_TIMING.upAfterCrashMs);
  });

  it('takes a second look at a container that exited with an error, then fails it', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running' }), container({ service: 'migrate', state: 'exited', exitCode: 1 })]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'exited', containers: [{ service: 'migrate', exitCode: 1 }] });
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.lookEveryMs);
  });

  it('does not fail a container its restart policy brings back after one look at it exited', () => {
    const verdict = watch((elapsedMs) =>
      elapsedMs === 0
        ? [container({ service: 'api', state: 'exited', exitCode: 1 })]
        : [container({ service: 'api', state: 'running', startedAtMs: START + 1000 })],
    );

    expect(verdict.outcome).toBe('up');
  });

  it('names the service that stopped for good before the ones crashing behind it', () => {
    const verdict = watch(() => [
      container({ service: 'api', state: 'restarting', exitCode: 1 }),
      container({ service: 'migrate', state: 'exited', exitCode: 3 }),
    ]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'exited', containers: [{ service: 'migrate' }, { service: 'api' }] });
  });

  it('fails a dead container at once', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running' }), container({ service: 'db', state: 'dead', exitCode: 137 })]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'exited', containers: [{ service: 'db' }] });
    expect(verdict.elapsedMs).toBe(0);
  });

  it('is fine with a one-shot that exited 0 beside a running service', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running' }), container({ service: 'setup', state: 'exited', exitCode: 0 })]);

    expect(verdict.outcome).toBe('up');
  });

  it('is fine with a service still Created beside a running one', () => {
    const verdict = watch(() => [
      container({ service: 'web', state: 'running' }),
      container({ service: 'worker', state: 'created', startedAtMs: null }),
    ]);

    expect(verdict.outcome).toBe('up');
  });

  it('fails an app whose every container exited 0, which is what the status sync calls stopped', () => {
    const verdict = watch(() => [container({ service: 'job', state: 'exited', exitCode: 0 })]);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'none_running', containers: [], containersSeen: 1 });
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.runningWithinMs);
  });

  it('waits for containers to appear, then fails an app that has none', () => {
    const verdict = watch(() => []);

    expect(verdict).toMatchObject({ outcome: 'failed', kind: 'none_running', containersSeen: 0 });
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.runningWithinMs);
  });

  it('does not hold a healthy app up when the Docker clock runs ahead of the Hub', () => {
    const verdict = watch(() => [container({ service: 'web', state: 'running', startedAtMs: START + 3_600_000 })]);

    expect(verdict.outcome).toBe('up');
    expect(verdict.elapsedMs).toBe(APP_CAME_UP_TIMING.upAfterMs);
  });
});

describe('reasonFromLogs', () => {
  it('takes the last line when none looks like a failure, without colour codes', () => {
    expect(reasonFromLogs('starting\n\u001b[31mshutting down now\u001b[0m\n\n   \n')).toBe('shutting down now');
  });

  it('prefers the line that says what went wrong over the next run starting up', () => {
    const logs = [
      'Starting services...',
      '/app/.venv/bin/uvicorn: /app/.venv/bin/python: bad interpreter: Permission denied',
      'A service exited (status 126); stopping the container so it restarts',
      'Starting services...',
      'Starting API server on port 8002...',
    ].join('\n');

    expect(reasonFromLogs(logs)).toBe('/app/.venv/bin/uvicorn: /app/.venv/bin/python: bad interpreter: Permission denied');
  });

  it('has nothing to say about an empty log', () => {
    expect(reasonFromLogs(' \n ')).toBeUndefined();
  });

  it('cuts a long line', () => {
    expect(reasonFromLogs('x'.repeat(500))).toBe(`${'x'.repeat(200)}...`);
  });
});

describe('describeAppServiceFailure', () => {
  it('names the service, the exit code and the last log line', () => {
    expect(
      describeAppServiceFailure({ kind: 'restarting', service: 'summary-service', exitCode: 126, logLine: 'exec /app/run: permission denied' }),
    ).toBe('summary-service keeps restarting (exit 126): exec /app/run: permission denied');
  });

  it('says how many more failed', () => {
    expect(describeAppServiceFailure({ kind: 'exited', service: 'migrate', others: 2, exitCode: 1 })).toBe('migrate and 2 more exited (exit 1)');
  });

  it('leaves out the exit code when none is known', () => {
    expect(describeAppServiceFailure({ kind: 'restarting', service: 'api' })).toBe('api keeps restarting');
  });

  it('has a sentence for an app with nothing running', () => {
    expect(describeAppServiceFailure({ kind: 'none_running' })).toBe("None of this app's services are running.");
  });
});
