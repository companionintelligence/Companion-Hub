import type { DockerService } from '../../docker/docker.service';
import type { CheckResult, ImagePlanItem } from './install-plan.types';

/**
 * Runs a throwing assertion and captures the result as a non-throwing {@link CheckResult}, so a
 * plan preview can report the same guards `install` runs (`assertForInstall`,
 * `assertHostDevicesAvailable`, ...) without their `throw` aborting plan construction.
 */
export async function toCheckResult(assertion: () => Promise<unknown> | undefined): Promise<CheckResult> {
  try {
    await assertion();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Read-only per-image cache lookup for a plan preview. Never pulls. */
export async function planImages(dockerService: DockerService, images: string[]): Promise<ImagePlanItem[]> {
  return Promise.all(
    images.map(async (image) => ({
      image,
      cachedLocally: await dockerService.imageExistsLocally(image),
    })),
  );
}
