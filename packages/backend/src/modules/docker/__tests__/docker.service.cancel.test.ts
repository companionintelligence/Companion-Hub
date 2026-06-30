import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mock } from 'vitest-mock-extended';
import { DockerService } from '../docker.service';

/**
 * Construct a DockerService with mocked dependencies. Only `logger` and the Dockerode handle are
 * exercised by the cancellation paths under test, so the rest are generic mocks.
 */
function makeService(dockerMock: unknown): DockerService {
  return new DockerService(mock(), mock(), mock(), mock(), mock(), dockerMock as never);
}

// A self-contained, cross-platform long-running process (no reliance on an external `sleep` binary):
// spawn this Node runtime with a one-liner that idles until SIGTERM/SIGKILL.
const LONG_RUNNING_CMD = [process.execPath, '-e', 'setTimeout(() => {}, 30000)'];

describe('DockerService.runDockerCompose — cancellation (real spawn)', () => {
  it('throws AbortError immediately when the signal is already aborted', async () => {
    const svc = makeService({});
    const ac = new AbortController();
    ac.abort();

    await expect(
      (svc as unknown as { runDockerCompose: (...a: unknown[]) => Promise<unknown> }).runDockerCompose(
        LONG_RUNNING_CMD,
        process.cwd(),
        false,
        ac.signal,
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('kills a running process and rejects with AbortError on abort', async () => {
    const svc = makeService({});
    const ac = new AbortController();

    const promise = (svc as unknown as { runDockerCompose: (...a: unknown[]) => Promise<unknown> }).runDockerCompose(
      LONG_RUNNING_CMD,
      process.cwd(),
      false,
      ac.signal,
    );
    // Let the process spawn, then cancel it.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('DockerService.pullImages — cancellation', () => {
  it('throws AbortError without pulling when the signal is already aborted', async () => {
    const pull = vi.fn();
    const svc = makeService({ pull });
    const ac = new AbortController();
    ac.abort();

    await expect(svc.pullImages(['img:1'], { forcePull: true, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('destroys the pull stream and rejects when aborted mid-pull', async () => {
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    // followProgress never finishes → the pull stays in-flight until we abort.
    const followProgress = vi.fn();
    const pull = vi.fn((_img: string, cb: (e: Error | null, s?: unknown) => void) => cb(null, stream));
    const svc = makeService({ pull, modem: { followProgress } });
    const ac = new AbortController();

    const promise = svc.pullImages(['img:1'], { forcePull: true, signal: ac.signal });
    await Promise.resolve(); // let the abort listener register
    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.destroy).toHaveBeenCalled();
  });

  it('does not destroy the stream when no signal is provided (existing behavior)', async () => {
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const followProgress = vi.fn((_s: unknown, onFinished: (e: Error | null, out: unknown[]) => void) => onFinished(null, []));
    const pull = vi.fn((_img: string, cb: (e: Error | null, s?: unknown) => void) => cb(null, stream));
    const svc = makeService({ pull, modem: { followProgress } });

    await expect(svc.pullImages(['img:1'], { forcePull: true })).resolves.toBeUndefined();
    expect(stream.destroy).not.toHaveBeenCalled();
  });
});
