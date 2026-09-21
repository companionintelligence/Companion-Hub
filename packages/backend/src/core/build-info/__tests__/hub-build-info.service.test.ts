import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, default: { ...actual, existsSync: existsSyncMock }, existsSync: existsSyncMock };
});

const { HubBuildInfoService } = await import('../hub-build-info.service');

const DIGEST = `sha256:${'14a090870a75'.padEnd(64, '0')}`;

/**
 * A `docker` child that emits `stdout` then closes with `code`. Minimal on purpose: the service
 * only ever reads stdout and the close code.
 */
function fakeDockerProcess(stdout: string, code = 0) {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const child = {
    stdout: { on: (_event: string, cb: (chunk: Buffer) => void) => queueMicrotask(() => cb(Buffer.from(stdout))) },
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] ??= [];
      handlers[event].push(cb);
      // Two hops, so the stdout chunk (queued one microtask deep above) always lands first.
      if (event === 'close') queueMicrotask(() => queueMicrotask(() => cb(code)));
      return child;
    },
    kill: vi.fn(),
  };
  return child;
}

describe('HubBuildInfoService', () => {
  beforeEach(() => {
    vi.stubEnv('CI_HUB_BUILD_VERSION', '0.2.73');
    vi.stubEnv('CI_HUB_BUILD_SHA', 'dac546bcffe0f105539615d94c8139e4522c050a');
    spawnMock.mockReset();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('merges the running image digest in when Docker answers', async () => {
    // The digest cannot be stamped at build time — the registry computes it from the pushed
    // manifest — so it is read back here. It is also the only thing that separates two images
    // sharing a tag, which is exactly the fleet state that prompted this endpoint.
    existsSyncMock.mockReturnValue(true);
    spawnMock
      .mockReturnValueOnce(fakeDockerProcess('sha256:imageconfigid\n'))
      .mockReturnValueOnce(fakeDockerProcess(`ghcr.io/companionintelligence/ci-hub@${DIGEST}\n`));

    const info = await new HubBuildInfoService(mock<LoggerService>()).getBuildInfoWithDigest();

    expect(info.imageDigest).toBe(DIGEST);
    expect(info.version).toBe('0.2.73');
  });

  it('answers with the stamp alone when there is no Docker socket', async () => {
    // The endpoint's whole point is answering while other things are broken, so a failed digest
    // lookup must cost the caller nothing but a null.
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockReturnValue(fakeDockerProcess('', 1));

    const info = await new HubBuildInfoService(mock<LoggerService>()).getBuildInfoWithDigest();

    expect(info.imageDigest).toBeNull();
    expect(info.version).toBe('0.2.73');
  });

  it('never shells out when the Hub is not in a container', async () => {
    // Source-based local dev runs the backend bare on the host; spawning `docker inspect ci-hub`
    // there would either fail slowly or, worse, describe a container that is not this process.
    existsSyncMock.mockReturnValue(false);

    const info = await new HubBuildInfoService(mock<LoggerService>()).getBuildInfoWithDigest();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(info.imageDigest).toBeNull();
  });

  it('rejects output that is not a digest rather than echoing it', async () => {
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockReturnValueOnce(fakeDockerProcess('sha256:imageconfigid\n')).mockReturnValueOnce(fakeDockerProcess('<no value>\n'));

    expect((await new HubBuildInfoService(mock<LoggerService>()).getBuildInfoWithDigest()).imageDigest).toBeNull();
  });

  it('looks the digest up once and reuses it', async () => {
    // A container's image cannot change under it, and a node with no socket must not spawn a
    // doomed `docker` per request.
    existsSyncMock.mockReturnValue(true);
    spawnMock
      .mockReturnValueOnce(fakeDockerProcess('sha256:imageconfigid\n'))
      .mockReturnValueOnce(fakeDockerProcess(`ghcr.io/companionintelligence/ci-hub@${DIGEST}\n`));

    const service = new HubBuildInfoService(mock<LoggerService>());
    await service.getBuildInfoWithDigest();
    await service.getBuildInfoWithDigest();

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('exposes the stamp synchronously for the boot log', () => {
    expect(new HubBuildInfoService(mock<LoggerService>()).getBuildInfo().summary).toBe('0.2.73 (dac546bcf)');
  });
});
