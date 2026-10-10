import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '../docker.service';

type PullEvent = { id?: string; status?: string; progressDetail?: { current?: number; total?: number } };
type FollowProgress = (
  stream: unknown,
  onFinished: (error: Error | null, output: unknown[]) => void,
  onProgress?: (event: PullEvent) => void,
) => void;

const IMAGE = 'ghcr.io/gchq/cyberchef:latest';

/** A Docker daemon whose pull stream is driven by `followProgress`. */
function serviceWithPull(followProgress: FollowProgress) {
  const logger = mock<LoggerService>();
  const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const pull = vi.fn((_image: string, callback: (error: Error | null, stream?: unknown) => void) => callback(null, stream));
  const service = new DockerService(logger, mock(), mock(), mock(), mock(), { pull, modem: { followProgress } } as never, mock());
  const infoLines = () => logger.info.mock.calls.map(([line]) => String(line));
  return { service, stream, infoLines };
}

/** Records how a pull settled without failing the test on an expected rejection. */
function watch(promise: Promise<void>) {
  const outcome: { error?: Error; resolved?: boolean } = {};
  promise.then(
    () => {
      outcome.resolved = true;
    },
    (error: Error) => {
      outcome.error = error;
    },
  );
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerService.pullImages: a pull that never starts', () => {
  it('fails after two minutes with no event, saying the download has not started', async () => {
    vi.useFakeTimers();
    // Docker answers the request and then sends nothing at all.
    const { service, stream } = serviceWithPull(() => {});

    const outcome = watch(service.pullImages([IMAGE], { forcePull: true }));
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(outcome.error?.message).toMatch(/hasn't started/);
    expect(outcome.error?.message).toContain(IMAGE);
    expect(outcome.error?.name).not.toBe('AbortError');
    expect(stream.destroy).toHaveBeenCalled();
  });

  it('fails the same way when Docker never answers the pull request', async () => {
    vi.useFakeTimers();
    const logger = mock<LoggerService>();
    const pull = vi.fn(); // the callback never runs
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), { pull, modem: { followProgress: vi.fn() } } as never, mock());

    const outcome = watch(service.pullImages([IMAGE], { forcePull: true }));
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(outcome.error?.message).toMatch(/hasn't started/);
    expect(logger.warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('never answered the pull request'));
  });

  it('keeps waiting past two minutes once Docker has sent an event', async () => {
    vi.useFakeTimers();
    // One event, then a quiet spell shorter than the 10-minute stall timeout.
    const { service } = serviceWithPull((_stream, _onFinished, onProgress) => {
      onProgress?.({ id: 'latest', status: 'Pulling from gchq/cyberchef' });
    });

    const outcome = watch(service.pullImages([IMAGE], { forcePull: true }));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(outcome.error).toBeUndefined();
  });
});

describe('DockerService.pullImages: what it logs', () => {
  it('logs when the pull starts and when its first event arrives', async () => {
    const { service, infoLines } = serviceWithPull((_stream, onFinished, onProgress) => {
      onProgress?.({ id: 'latest', status: 'Pulling from gchq/cyberchef' });
      onFinished(null, []);
    });

    await service.pullImages([IMAGE], { forcePull: true });

    expect(infoLines()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${IMAGE}: pull started`)),
        expect.stringMatching(new RegExp(`${IMAGE}: first event after [\\d.]+s \\(Pulling from gchq/cyberchef\\)`)),
      ]),
    );
  });

  it('logs the layer status every 30 seconds while the pull runs', async () => {
    vi.useFakeTimers();
    const { service, infoLines } = serviceWithPull((_stream, _onFinished, onProgress) => {
      onProgress?.({ id: 'layer-a', status: 'Downloading', progressDetail: { current: 1024 * 1024, total: 4 * 1024 * 1024 } });
      onProgress?.({ id: 'layer-b', status: 'Pull complete', progressDetail: {} });
    });

    watch(service.pullImages([IMAGE], { forcePull: true }));
    await vi.advanceTimersByTimeAsync(30 * 1000);

    expect(infoLines()).toContainEqual(expect.stringMatching(/0 of 1 images done, 1 of 2 layers, 1\.0 of 4\.0 MB/));
  });
});
