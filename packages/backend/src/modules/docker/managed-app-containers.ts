import type { AppServiceFailure } from '@ci-hub/common/schemas';

/** One container as one look saw it. */
export interface AppContainerLook {
  id: string;
  /** The compose service: what a person knows it by. */
  service: string;
  /** The container's own name: what `docker logs` takes. */
  containerName: string;
  state: string;
  exitCode: number | null;
  restartCount: number;
  startedAtMs: number | null;
  health: string | null;
}

export interface FailedAppContainer {
  service: string;
  containerName: string;
  state: string;
  exitCode: number | null;
}

export type AppCameUpVerdict =
  | { outcome: 'waiting' }
  | { outcome: 'up' }
  | { outcome: 'failed'; kind: AppServiceFailure['kind']; containers: FailedAppContainer[]; containersSeen: number };

/**
 * The windows of {@link AppCameUpWatch}. A healthy app costs at most `upAfterMs`, less when its
 * containers have been running for a while, as they have on a boot that recreates nothing.
 */
export const APP_CAME_UP_TIMING = {
  lookEveryMs: 1_000,
  /** How long a container runs with no sign of a crash before it counts as up. */
  upAfterMs: 5_000,
  /** The same for a container seen crashing. Docker too calls a run of 10 s a clean start and resets its restart delay. */
  upAfterCrashMs: 10_000,
  /** How long a container seen crashing has to settle, so a service that crashes until its database is up is not called failed. */
  settleWithinMs: 30_000,
  /** How long to wait for one container to be running at all. */
  runningWithinMs: 10_000,
};

export type AppCameUpTiming = typeof APP_CAME_UP_TIMING;

interface TrackedContainer {
  firstRestartCount: number;
  crashed: boolean;
  lastExitCode: number | null;
  startedAtMs: number | null;
  /** When this run was first seen. Counts with `startedAtMs` so a daemon whose clock runs ahead of the Hub's cannot hold a healthy app up. */
  runSeenAtMs: number;
  exitedLooks: number;
}

/**
 * Decides, over several looks, whether an app's containers came up after `compose up`.
 *
 * One look cannot tell: a container that restarts every few seconds is `running` for a moment each
 * time. Install used to count `running` containers once and passed about 1 time in 5 against a
 * service exiting 126.
 *
 * - `restarting`, or a restart count that climbs, is a crash. The container then has to run for
 *   `upAfterCrashMs` before `settleWithinMs` ends.
 * - Exited with an error, or `dead`, is a failure after a second look, since a restart policy may be
 *   bringing it back.
 * - Exited 0 is a finished one-shot and `created` is left to compose. Neither holds the answer up,
 *   but one container has to be running. An app whose every container exited 0 is stopped.
 * - `running` with a health check still `starting` counts by its run time alone: many store apps take
 *   minutes to answer, which the app page shows as Initializing. That is not a failure.
 *
 * A crash that first comes after `upAfterMs` is not seen here. The status sync reports it as a crash.
 */
export class AppCameUpWatch {
  private readonly tracked = new Map<string, TrackedContainer>();
  private readonly startedAtMs: number;
  private looks = 0;

  constructor(
    nowMs: number,
    private readonly timing: AppCameUpTiming = APP_CAME_UP_TIMING,
  ) {
    this.startedAtMs = nowMs;
  }

  judge(containers: AppContainerLook[], nowMs: number): AppCameUpVerdict {
    this.looks += 1;
    const elapsedMs = nowMs - this.startedAtMs;
    const stoppedForGood: FailedAppContainer[] = [];
    const crashing: FailedAppContainer[] = [];
    let running = 0;
    let oneMoreLook = false;

    for (const container of containers) {
      const seen = this.track(container, nowMs);
      const failed = { service: container.service, containerName: container.containerName, state: container.state, exitCode: seen.lastExitCode };

      if (container.state === 'dead' || (container.state === 'exited' && container.exitCode !== 0)) {
        if (container.state === 'dead' || seen.exitedLooks >= 2) {
          stoppedForGood.push(failed);
        } else {
          oneMoreLook = true;
        }
      } else if (container.state === 'restarting') {
        crashing.push(failed);
      } else if (container.state === 'running') {
        running += 1;
        const ranForMs = Math.max(nowMs - seen.runSeenAtMs, container.startedAtMs === null ? 0 : nowMs - container.startedAtMs);
        const isUp = container.health === 'healthy' || ranForMs >= (seen.crashed ? this.timing.upAfterCrashMs : this.timing.upAfterMs);
        if (!isUp && seen.crashed) {
          crashing.push(failed);
        } else if (!isUp) {
          oneMoreLook = true;
        }
      }
    }

    if (stoppedForGood.length > 0) {
      // The stopped one first: a failed migration is usually why the services behind it crash.
      return { outcome: 'failed', kind: 'exited', containers: [...stoppedForGood, ...crashing], containersSeen: containers.length };
    }
    if (crashing.length > 0) {
      return elapsedMs >= this.timing.settleWithinMs
        ? { outcome: 'failed', kind: 'restarting', containers: crashing, containersSeen: containers.length }
        : { outcome: 'waiting' };
    }
    if (running === 0) {
      return elapsedMs >= this.timing.runningWithinMs
        ? { outcome: 'failed', kind: 'none_running', containers: [], containersSeen: containers.length }
        : { outcome: 'waiting' };
    }
    return this.looks < 2 || (oneMoreLook && elapsedMs < this.timing.settleWithinMs) ? { outcome: 'waiting' } : { outcome: 'up' };
  }

  private track(container: AppContainerLook, nowMs: number): TrackedContainer {
    let seen = this.tracked.get(container.id);
    if (!seen) {
      seen = {
        firstRestartCount: container.restartCount,
        crashed: false,
        lastExitCode: null,
        startedAtMs: container.startedAtMs,
        runSeenAtMs: nowMs,
        exitedLooks: 0,
      };
      this.tracked.set(container.id, seen);
    }

    if (container.startedAtMs !== seen.startedAtMs) {
      seen.startedAtMs = container.startedAtMs;
      seen.runSeenAtMs = nowMs;
    }
    seen.crashed ||= container.state === 'restarting' || container.restartCount > seen.firstRestartCount;
    seen.exitedLooks = container.state === 'exited' ? seen.exitedLooks + 1 : 0;
    // A running or created container reports 0, so the code from its last crash has to be kept.
    if ((container.state === 'exited' || container.state === 'dead' || container.state === 'restarting') && container.exitCode !== null) {
      seen.lastExitCode = container.exitCode;
    }
    return seen;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes are what this removes.
const COLOUR_CODES = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Words a log line that says why a service died tends to carry. */
const LOOKS_LIKE_A_FAILURE = /\b(error|errno|fatal|panic|exception|traceback|denied|not found|no such|failed|cannot|unable|refused|invalid)\b/i;

/**
 * The log line that best says why a container died, short enough for a toast: the last one that looks
 * like a failure, or else the last one. By the time anyone reads a crash loop's log its next run may
 * be starting up, and "Starting server on port 8002..." says nothing about the run that died.
 */
export function reasonFromLogs(logs: string, maxLength = 200): string | undefined {
  const lines = logs
    .replace(COLOUR_CODES, '')
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean);
  const line = lines.findLast((text) => LOOKS_LIKE_A_FAILURE.test(text)) ?? lines.at(-1);
  if (!line) {
    return undefined;
  }
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line;
}

/** The English sentence for a failure, for the logs, the lifecycle job and any client that has no translation. */
export function describeAppServiceFailure(failure: AppServiceFailure): string {
  if (failure.kind === 'none_running' || !failure.service) {
    return "None of this app's services are running.";
  }
  const service = failure.others ? `${failure.service} and ${failure.others} more` : failure.service;
  const exit = failure.exitCode === undefined ? '' : ` (exit ${failure.exitCode})`;
  const reason = failure.kind === 'restarting' ? `${service} keeps restarting${exit}` : `${service} exited${exit}`;
  return failure.logLine ? `${reason}: ${failure.logLine}` : reason;
}
