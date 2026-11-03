import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import { CONTAINERD_PULL_EVENTS, CONTAINERD_PULL_MANIFEST } from './containerd-pull.fixture';
import { DockerService, type DockerPullProgressEvent } from '../docker.service';

type PullEvent = { id?: string; status?: string; progressDetail?: { current?: number; total?: number; units?: string; hidecounts?: boolean } };
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
  const warnLines = () => logger.warn.mock.calls.map(([line]) => String(line));
  return { service, stream, infoLines, warnLines };
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

  it('does not report a timeout for another image once the pull has already failed', async () => {
    vi.useFakeTimers();
    const logger = mock<LoggerService>();
    const OTHER = 'ghcr.io/example/sidecar:1';
    // The sidecar's pull fails at once; Docker never answers the main image's.
    const pull = vi.fn((image: string, callback: (error: Error | null) => void) => {
      if (image === OTHER) callback(new Error('manifest unknown'));
    });
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), { pull, modem: { followProgress: vi.fn() } } as never, mock());

    const outcome = watch(service.pullImages([IMAGE, OTHER], { forcePull: true }));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(outcome.error?.message).toContain('manifest unknown');
    expect(logger.warn.mock.calls.map(([line]) => String(line))).not.toContainEqual(expect.stringContaining('[pull-timeout]'));
  });

  it('ends a pull cancelled while it looked for a local copy, without asking Docker for it', async () => {
    vi.useFakeTimers();
    const logger = mock<LoggerService>();
    let missing!: (error: Error) => void;
    const inspect = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          missing = reject;
        }),
    );
    const pull = vi.fn(); // Docker never answers
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), { getImage: () => ({ inspect }), pull } as never, mock());
    const cancel = new AbortController();

    const outcome = watch(service.pullImages([IMAGE], { signal: cancel.signal }));
    await vi.advanceTimersByTimeAsync(0);
    cancel.abort();
    missing(new Error('No such image'));
    // Past every pull timeout: an aborted pull disarms them, so only the cancel itself can end it.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(outcome.error?.name).toBe('AbortError');
    expect(pull).not.toHaveBeenCalled();
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

describe('DockerService.pullImages: the download size it reports (#2177)', () => {
  const MB = 1024 * 1024;
  const A = 'aaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbb';
  const C = 'cccccccccccc';
  const digest = (id: string) => `sha256:${id}${'0'.repeat(52)}`;

  /** Three layers announced, then the first starts downloading, then the pull finishes. */
  const threeLayerPull: FollowProgress = (_stream, onFinished, onProgress) => {
    for (const id of [A, B, C]) onProgress?.({ id, status: 'Pulling fs layer' });
    onProgress?.({ id: A, status: 'Downloading', progressDetail: { current: MB, total: 4 * MB } });
    setTimeout(() => onFinished(null, []), 5);
  };

  it('says the total is not known while layers are still waiting to report their size', async () => {
    const { service } = serviceWithPull(threeLayerPull);
    const ticks: Array<{ totalBytes: number; totalBytesKnown: boolean }> = [];

    await service.pullImages([IMAGE], { forcePull: true, onProgress: (event) => ticks.push(event) });

    const downloading = ticks.find((tick) => tick.totalBytes === 4 * MB);
    expect(downloading?.totalBytesKnown).toBe(false);
    expect(ticks.at(-1)?.totalBytesKnown).toBe(true);
  });

  it('reports the whole download once the registry has given the layer sizes', async () => {
    const { service } = serviceWithPull(threeLayerPull);
    const ticks: Array<{ totalBytes: number; totalBytesKnown: boolean }> = [];
    const sizes = new Map([
      [digest(A), 4 * MB],
      [digest(B), 2 * MB],
      [digest(C), 20 * MB],
    ]);

    await service.pullImages([IMAGE], {
      forcePull: true,
      layerSizes: async () => sizes,
      onProgress: (event) => ticks.push(event),
    });

    expect(ticks.filter((tick) => tick.totalBytesKnown).map((tick) => tick.totalBytes)).toContain(26 * MB);
    expect(ticks.some((tick) => tick.totalBytesKnown && tick.totalBytes < 26 * MB)).toBe(false);
  });

  it('pulls without waiting for the registry', async () => {
    const { service } = serviceWithPull(threeLayerPull);
    const never = new Promise<ReadonlyMap<string, number>>(() => {});

    await expect(service.pullImages([IMAGE], { forcePull: true, layerSizes: () => never })).resolves.toBeUndefined();
  });

  it('reports the same ticks when the lookup fails as with no lookup and logs why', async () => {
    const without = serviceWithPull(threeLayerPull);
    const failing = serviceWithPull(threeLayerPull);
    const ticksWithout: DockerPullProgressEvent[] = [];
    const ticksFailing: DockerPullProgressEvent[] = [];

    await without.service.pullImages([IMAGE], { forcePull: true, onProgress: (event) => ticksWithout.push(event) });
    await failing.service.pullImages([IMAGE], {
      forcePull: true,
      layerSizes: () => Promise.reject(new Error('registry down')),
      onProgress: (event) => ticksFailing.push(event),
    });

    expect(ticksFailing).toEqual(ticksWithout);
    expect(failing.warnLines()).toContainEqual(expect.stringContaining('no layer sizes from the registry (registry down)'));
  });

  it('does not blame the registry when reporting the sizes fails', async () => {
    const { service, warnLines } = serviceWithPull(threeLayerPull);
    const sizes = new Map([[digest(A), 4 * MB]]);
    let calls = 0;

    await service.pullImages([IMAGE], {
      forcePull: true,
      layerSizes: async () => sizes,
      onProgress: () => {
        calls += 1;
        // The report the manifest triggers comes after Docker's four events.
        if (calls === 5) throw new Error('page gone');
      },
    });

    expect(warnLines()).toContainEqual(expect.stringContaining('progress update failed (page gone)'));
    expect(warnLines()).not.toContainEqual(expect.stringContaining('no layer sizes from the registry'));
  });

  it('gives the lookup a signal that fires when the pull is cancelled', async () => {
    const { service } = serviceWithPull(() => {});
    const cancel = new AbortController();
    let lookupSignal: AbortSignal | undefined;

    const outcome = watch(
      service.pullImages([IMAGE], {
        forcePull: true,
        signal: cancel.signal,
        layerSizes: (_image, signal) => {
          lookupSignal = signal;
          return new Promise(() => {});
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancel.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lookupSignal?.aborted).toBe(true);
    expect(outcome.error?.name).toBe('AbortError');
  });

  it('is not known while another image of the app is still being looked for locally', async () => {
    const OTHER = 'ghcr.io/example/sidecar:1';
    const logger = mock<LoggerService>();
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const pull = vi.fn((_image: string, callback: (error: Error | null, stream?: unknown) => void) => callback(null, stream));
    let sidecarMissing!: (error: Error) => void;
    const getImage = (image: string) => ({
      inspect: () =>
        image === OTHER
          ? new Promise((_resolve, reject) => {
              sidecarMissing = reject;
            })
          : Promise.reject(new Error('No such image')),
    });
    const service = new DockerService(
      logger,
      mock(),
      mock(),
      mock(),
      mock(),
      { getImage, pull, modem: { followProgress: replay(CONTAINERD_PULL_EVENTS) } } as never,
      mock(),
    );
    const ticks: DockerPullProgressEvent[] = [];

    const outcome = watch(
      service.pullImages([IMAGE, OTHER], { layerSizes: async () => CONTAINERD_PULL_MANIFEST, onProgress: (event) => ticks.push(event) }),
    );
    await vi.waitFor(() => expect(ticks.some((tick) => tick.completedImages === 1)).toBe(true));

    expect(ticks.some((tick) => tick.totalBytesKnown)).toBe(false);
    sidecarMissing(new Error('No such image'));
    await vi.waitFor(() => expect(outcome.resolved).toBe(true));
  });
});

/** Plays recorded events back one per macrotask, as Docker's stream would, then ends the pull. */
function replay(events: readonly PullEvent[]): FollowProgress {
  return (_stream, onFinished, onProgress) => {
    void (async () => {
      for (const event of events) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        onProgress?.(event);
      }
      onFinished(null, []);
    })();
  };
}

describe('DockerService.pullImages: replays of real pulls (#2177)', () => {
  const MB = 1024 * 1024;
  const sum = (sizes: Iterable<number>) => [...sizes].reduce((total, size) => total + size, 0);
  // The base layer was on disk and never mentioned. 082792796f10 is a 23,701-byte blob outside the image's layers.
  const DOWNLOADED = sum(CONTAINERD_PULL_MANIFEST.values()) - 3_846_391 + 23_701;

  async function pullTicks(followProgress: FollowProgress, layerSizes?: () => Promise<ReadonlyMap<string, number>>) {
    const { service } = serviceWithPull(followProgress);
    const ticks: DockerPullProgressEvent[] = [];
    await service.pullImages([IMAGE], { forcePull: true, layerSizes, onProgress: (event) => ticks.push(event) });
    return ticks;
  }

  it('containerd store, with the manifest: one final total from the first download, over the whole bar', async () => {
    const ticks = await pullTicks(replay(CONTAINERD_PULL_EVENTS), async () => CONTAINERD_PULL_MANIFEST);
    const known = ticks.filter((tick) => tick.totalBytesKnown);
    const firstKnown = ticks.indexOf(known[0]);

    expect(new Set(known.map((tick) => tick.totalBytes))).toEqual(new Set([DOWNLOADED]));
    // Known by the time the big layers start, not only at the end.
    expect(ticks[firstKnown].completedBytes).toBeLessThan(DOWNLOADED / 10);
    expect(ticks.at(-1)).toMatchObject({ completedBytes: DOWNLOADED, totalBytes: DOWNLOADED, totalBytesKnown: true });
  });

  it('containerd store, without the manifest: known once the big layers report and steady after', async () => {
    const ticks = await pullTicks(replay(CONTAINERD_PULL_EVENTS));
    const known = ticks.filter((tick) => tick.totalBytesKnown);

    expect(known.length).toBeGreaterThan(10);
    expect(new Set(known.map((tick) => tick.totalBytes)).size).toBe(1);
  });

  it('classic store, with the manifest: known before any download, without the layer already on disk', async () => {
    const [base, app, data] = ['1111aaaa2222', '3333bbbb4444', '5555cccc6666'];
    const manifest = new Map([
      [`sha256:${base}${'0'.repeat(52)}`, 3 * MB],
      [`sha256:${app}${'0'.repeat(52)}`, 2 * MB],
      [`sha256:${data}${'0'.repeat(52)}`, 20 * MB],
    ]);
    const classic: PullEvent[] = [
      { id: 'latest', status: 'Pulling from gchq/cyberchef' },
      { id: base, status: 'Already exists' },
      { id: app, status: 'Pulling fs layer' },
      { id: data, status: 'Pulling fs layer' },
      { id: app, status: 'Waiting' },
      { id: app, status: 'Downloading', progressDetail: { current: MB, total: 2 * MB } },
      { id: data, status: 'Downloading', progressDetail: { current: MB, total: 20 * MB } },
      { id: app, status: 'Verifying Checksum' },
      { id: app, status: 'Download complete' },
      { id: app, status: 'Extracting', progressDetail: { current: MB, total: 2 * MB } },
      { id: app, status: 'Pull complete' },
      { id: data, status: 'Downloading', progressDetail: { current: 20 * MB, total: 20 * MB } },
      { id: data, status: 'Download complete' },
      { id: data, status: 'Extracting', progressDetail: { current: 20 * MB, total: 20 * MB } },
      { id: data, status: 'Pull complete' },
    ];

    const ticks = await pullTicks(replay(classic), async () => manifest);
    const known = ticks.filter((tick) => tick.totalBytesKnown);

    expect(new Set(known.map((tick) => tick.totalBytes))).toEqual(new Set([22 * MB]));
    expect(known[0].completedBytes).toBe(0);
    expect(ticks.at(-1)).toMatchObject({ completedBytes: 22 * MB, totalBytesKnown: true });
  });
});
