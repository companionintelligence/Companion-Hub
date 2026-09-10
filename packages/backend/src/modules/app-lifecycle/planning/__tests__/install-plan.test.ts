import { describe, it, expect } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { DockerService } from '../../docker/docker.service';
import { toCheckResult, planImages } from '../install-plan';

describe('toCheckResult', () => {
  it('reports ok when the assertion resolves', async () => {
    await expect(toCheckResult(async () => undefined)).resolves.toEqual({ ok: true });
  });

  it('captures a thrown Error message as the reason', async () => {
    await expect(
      toCheckResult(async () => {
        throw new Error('device not available');
      }),
    ).resolves.toEqual({ ok: false, reason: 'device not available' });
  });

  it('stringifies a non-Error throw', async () => {
    await expect(
      toCheckResult(() => {
        throw 'boom';
      }),
    ).resolves.toEqual({ ok: false, reason: 'boom' });
  });

  it('treats an optional-service call that resolves to undefined as ok (unavailable service, not a failure)', async () => {
    const maybeAssert: (() => Promise<void>) | undefined = undefined;
    await expect(toCheckResult(() => maybeAssert?.())).resolves.toEqual({ ok: true });
  });
});

describe('planImages', () => {
  it('reports cache status per image without pulling', async () => {
    const dockerService = mock<DockerService>() as MockProxy<DockerService>;
    dockerService.imageExistsLocally.mockImplementation(async (image) => image === 'ghcr.io/ci/cached:latest');

    const result = await planImages(dockerService, ['ghcr.io/ci/cached:latest', 'ghcr.io/ci/missing:latest']);

    expect(result).toEqual([
      { image: 'ghcr.io/ci/cached:latest', cachedLocally: true },
      { image: 'ghcr.io/ci/missing:latest', cachedLocally: false },
    ]);
    expect(dockerService.imageExistsLocally).toHaveBeenCalledTimes(2);
  });

  it('returns an empty plan for no images', async () => {
    const dockerService = mock<DockerService>() as MockProxy<DockerService>;
    await expect(planImages(dockerService, [])).resolves.toEqual([]);
  });
});
