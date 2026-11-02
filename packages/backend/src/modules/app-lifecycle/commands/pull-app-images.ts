import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { DockerService } from '@/modules/docker/docker.service';
import type { AppUrn } from '@ci-hub/common/types';

type PullRecordDeps = {
  docker: Pick<DockerService, 'imageIdLocally'>;
  files: Pick<AppFilesManager, 'readPulledImageIds' | 'writePulledImageIds'>;
  logger: Pick<LoggerService, 'warn'>;
};

/**
 * Runs `pull` for an app's image references and records, for that app, the images the pull brought onto this
 * computer. Uninstall removes exactly what the record holds, so an image that was here before the app, and that
 * the app did not bring in, is never recorded and never removed.
 *
 * A reference belongs to the app when it named no image before the pull, so the pull brought the image in, or when
 * the image it named was one the app already recorded, so this pull replaces the app's own image (an update).
 *
 * The record is written even when `pull` fails part-way: an image that did arrive is the app's to remove.
 */
export async function pullAppImagesRecorded(deps: PullRecordDeps, appUrn: AppUrn, imageRefs: string[], pull: () => Promise<unknown>): Promise<void> {
  const { docker, files, logger } = deps;
  const recorded = new Set(await files.readPulledImageIds(appUrn));

  const appRefs: string[] = [];
  for (const ref of new Set(imageRefs)) {
    const idBefore = await docker.imageIdLocally(ref);
    if (!idBefore || recorded.has(idBefore)) {
      appRefs.push(ref);
    }
  }

  try {
    await pull();
  } finally {
    try {
      const countBefore = recorded.size;
      for (const ref of appRefs) {
        const idAfter = await docker.imageIdLocally(ref);
        if (idAfter) {
          recorded.add(idAfter);
        }
      }

      if (recorded.size !== countBefore && !(await files.writePulledImageIds(appUrn, [...recorded]))) {
        logger.warn(`Could not record the images pulled for ${appUrn}; uninstalling it will not remove them`);
      }
    } catch (error) {
      logger.warn(`Could not record the images pulled for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
