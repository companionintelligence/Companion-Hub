import type { Architecture } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { withTimeout } from '@/common/helpers/with-timeout';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerService } from '@/modules/docker/docker.service';
import { parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';

type PullRecordDeps = {
  docker: Pick<DockerService, 'imageIdLocally'>;
  files: Pick<AppFilesManager, 'readPulledImageIds' | 'writePulledImageIds'>;
  logger: Pick<LoggerService, 'warn'>;
};

/** A lookup is a local Docker call. A Docker engine that stops answering must not hold up the command or hide why `pull` failed. */
const IMAGE_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Runs `pull` for an app's image references and records, for that app, the images the pull brought onto this
 * computer. Uninstall removes exactly what the record holds, so an image that was here before the app, and that
 * the app did not bring in, is never recorded and never removed.
 *
 * A reference belongs to the app when it named no image before the pull, so the pull brought the image in, or when
 * the image it named was one the app already recorded, so this pull replaces the app's own image (an update). One
 * that can't be looked up doesn't belong to it: that must not stop the pull and nothing shows the app brought it in.
 *
 * The record is written even when `pull` fails part-way: an image that did arrive is the app's to remove.
 */
export async function pullAppImagesRecorded(deps: PullRecordDeps, appUrn: AppUrn, imageRefs: string[], pull: () => Promise<unknown>): Promise<void> {
  const { docker, files, logger } = deps;
  const recorded = new Set(await files.readPulledImageIds(appUrn));
  const lookUp = (ref: string) => withTimeout(docker.imageIdLocally(ref), IMAGE_LOOKUP_TIMEOUT_MS, 'the Docker engine did not answer in time');

  const appRefs: string[] = [];
  for (const ref of new Set(imageRefs)) {
    try {
      const idBefore = await lookUp(ref);
      if (!idBefore || recorded.has(idBefore)) {
        appRefs.push(ref);
      }
    } catch (error) {
      logger.warn(
        `Could not look up ${ref} before pulling for ${appUrn}, so it is not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    await pull();
  } finally {
    const countBefore = recorded.size;
    for (const ref of appRefs) {
      // One image that can't be looked up must not lose the others: the next start would take them for images that were here.
      try {
        const idAfter = await lookUp(ref);
        if (idAfter) {
          recorded.add(idAfter);
        }
      } catch (error) {
        logger.warn(
          `Could not look up ${ref} after pulling for ${appUrn}, so it is not recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      if (recorded.size !== countBefore && !(await files.writePulledImageIds(appUrn, [...recorded]))) {
        logger.warn(`Could not record the images pulled for ${appUrn}; uninstalling it will not remove them`);
      }
    } catch (error) {
      logger.warn(`Could not record the images pulled for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The distinct image references a compose's services name. */
export function uniqueServiceImages(services: Array<{ image?: string }>): string[] {
  return [...new Set(services.map((service) => service.image?.trim()).filter((image): image is string => Boolean(image)))];
}

/** The images an installed app's compose names on this computer's architecture. */
export function installedComposeImages(composeContent: unknown, architecture: Architecture): string[] {
  const { services, overrides } = parseInstalledComposeJson(composeContent);

  return uniqueServiceImages(mergeArchitectureOverrides(services, overrides, architecture));
}

/**
 * Runs a `compose up` and records what it pulled, by the rule of {@link pullAppImagesRecorded}. Compose pulls whatever
 * the app names that isn't here, which is where a custom app gets its images, since it has no install step. An install
 * gets an image there when its own pull didn't name it. An up that pulls nothing records nothing. Nothing here may fail
 * the command: a compose that can't be read goes unrecorded.
 */
export async function recordComposeUpPulls(moduleRef: ModuleRef, appUrn: AppUrn, up: () => Promise<unknown>): Promise<void> {
  const logger = moduleRef.get(LoggerService, { strict: false });
  const files = moduleRef.get(AppFilesManager, { strict: false });
  const docker = moduleRef.get(DockerService, { strict: false });

  let imageRefs: string[] = [];
  try {
    const { content } = await files.getDockerComposeJson(appUrn);
    imageRefs = content ? installedComposeImages(content, moduleRef.get(ConfigurationService, { strict: false })?.get('architecture')) : [];
  } catch (error) {
    logger.warn(
      `Could not read which images ${appUrn} uses, so none it pulls now is recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await pullAppImagesRecorded({ docker, files, logger }, appUrn, imageRefs, up);
}
