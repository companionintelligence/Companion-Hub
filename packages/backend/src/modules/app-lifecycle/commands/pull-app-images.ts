import type { Architecture } from '@/common/constants';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { withTimeout } from '@/common/helpers/with-timeout';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager, type PulledImages } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { isPortExposeApp, type AppSecurityGrants, parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import { securityGrantsFor } from '@/modules/apps/security-grants';

type PullRecordDeps = {
  docker: Pick<DockerService, 'imageIdLocally' | 'imageIdsLocally' | 'imageTagsLocally'>;
  files: Pick<AppFilesManager, 'readPulledImages' | 'addPulledImages'>;
  logger: Pick<LoggerService, 'warn'>;
};

/** A lookup is a local Docker call. A Docker engine that stops answering must not hold up the command or hide why `pull` failed. */
const IMAGE_LOOKUP_TIMEOUT_MS = 15_000;

const inTime = <T>(lookup: Promise<T>): Promise<T> => withTimeout(lookup, IMAGE_LOOKUP_TIMEOUT_MS, 'the Docker engine did not answer in time');

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs `pull` for an app's image references and records, for that app, the images the pull brought onto this
 * computer. Uninstall removes exactly what the record holds, so an image that was here before the app, and that
 * no app's pull brought in, is never recorded and never removed. The one other way onto a record is
 * {@link handOverKeptImages}: an image another app brought in and left behind for this one.
 *
 * A reference belongs to the app when it named no image before the pull, so the pull brought the image in, or when
 * the image it named was one the app already recorded, so this pull replaces the app's own image (an update). One
 * that can't be looked up doesn't belong to it: that must not stop the pull and nothing shows the app brought it in.
 *
 * A pull can land a reference on an image that was here under another name, whether the reference named no image or
 * a `forced` pull moved its tag, so what's here is compared by ID too. That list takes a few hundred milliseconds on a
 * computer with hundreds of images, so it is asked for only when one of those can happen: a start that pulls nothing
 * doesn't pay for it. If it can't be had, nothing shows the pull brought anything in.
 *
 * Only a new image gets its tags recorded. One the app already holds may have a tag someone else gave it since, which
 * must stay someone else's: uninstall then keeps the image rather than remove it with that tag.
 *
 * The record is written even when `pull` fails part-way: an image that did arrive is the app's to remove. It is added
 * to rather than replaced: a pull can take minutes and another app's uninstall can hand this app an image in that time.
 */
export async function pullAppImagesRecorded(
  deps: PullRecordDeps,
  appUrn: AppUrn,
  imageRefs: string[],
  pull: () => Promise<unknown>,
  options: { forced: boolean },
): Promise<void> {
  const { docker, files, logger } = deps;
  const recorded = new Set<string>();
  const tags = new Set<string>();
  try {
    const { imageIds, imageTags } = await files.readPulledImages(appUrn);
    for (const imageId of imageIds) {
      recorded.add(imageId);
    }
    for (const tag of imageTags) {
      tags.add(tag);
    }
  } catch (error) {
    logger.warn(`Could not read the record of the images pulled for ${appUrn}: ${errorText(error)}`);
  }

  const appRefs = new Map<string, string | null>();
  for (const ref of new Set(imageRefs)) {
    try {
      const idBefore = await inTime(docker.imageIdLocally(ref));
      if (!idBefore || recorded.has(idBefore)) {
        appRefs.set(ref, idBefore);
      }
    } catch (error) {
      logger.warn(`Could not look up ${ref} before pulling for ${appUrn}, so it is not recorded: ${errorText(error)}`);
    }
  }

  let idsHere: Set<string> | undefined;
  if (appRefs.size > 0 && (options.forced || [...appRefs.values()].includes(null))) {
    try {
      idsHere = await inTime(docker.imageIdsLocally());
    } catch (error) {
      logger.warn(`Could not list the images here before pulling for ${appUrn}, so the ones it pulls are not recorded: ${errorText(error)}`);
    }
  }

  try {
    await pull();
  } finally {
    const brought = new Set<string>();
    for (const [ref, idBefore] of appRefs) {
      // One image that can't be looked up must not lose the others: the next start would take them for images that were here.
      try {
        const idAfter = await inTime(docker.imageIdLocally(ref));
        if (idAfter && idAfter !== idBefore && idsHere && !idsHere.has(idAfter)) {
          brought.add(idAfter);
        }
      } catch (error) {
        logger.warn(`Could not look up ${ref} after pulling for ${appUrn}, so it is not recorded: ${errorText(error)}`);
      }
    }

    for (const imageId of brought) {
      recorded.add(imageId);
      // Without its tags the image is still the app's, but uninstall takes each of them for someone else's and keeps it.
      try {
        for (const tag of await inTime(docker.imageTagsLocally(imageId))) {
          tags.add(tag);
        }
      } catch (error) {
        logger.warn(`Could not read the tags of ${imageId} after pulling for ${appUrn}: ${errorText(error)}`);
      }
    }

    try {
      if (brought.size > 0 && !(await files.addPulledImages(appUrn, { imageIds: [...recorded], imageTags: [...tags] }))) {
        logger.warn(`Could not record the images pulled for ${appUrn}; uninstalling it will not remove them`);
      }
    } catch (error) {
      logger.warn(`Could not record the images pulled for ${appUrn}: ${errorText(error)}`);
    }
  }
}

/** The distinct image references a compose's services name. */
export function uniqueServiceImages(services: Array<{ image?: string }>): string[] {
  return [...new Set(services.map((service) => service.image?.trim()).filter((image): image is string => Boolean(image)))];
}

/** The images an installed app's compose names on this computer's architecture. */
export function installedComposeImages(composeContent: unknown, architecture: Architecture, grants?: AppSecurityGrants): string[] {
  const { services, overrides } = parseInstalledComposeJson(composeContent, grants);

  return uniqueServiceImages(mergeArchitectureOverrides(services, overrides, architecture));
}

/**
 * Runs a `compose up` and records what it pulled, by the rule of {@link pullAppImagesRecorded}. Compose pulls whatever
 * the app names that isn't here, which is where a custom app gets its images, since it has no install step. An install
 * gets an image there when its own pull didn't name it. An up that pulls nothing records nothing. Nothing here may fail
 * the command: a compose that can't be read goes unrecorded.
 */
export async function recordComposeUpPulls(
  moduleRef: ModuleRef,
  appUrn: AppUrn,
  up: () => Promise<unknown>,
  options: { forced: boolean },
): Promise<void> {
  const logger = moduleRef.get(LoggerService, { strict: false });
  const files = moduleRef.get(AppFilesManager, { strict: false });
  const docker = moduleRef.get(DockerService, { strict: false });

  let imageRefs: string[] = [];
  try {
    const { content } = await files.getDockerComposeJson(appUrn);
    imageRefs = content
      ? installedComposeImages(content, moduleRef.get(ConfigurationService, { strict: false })?.get('architecture'), securityGrantsFor(appUrn))
      : [];
  } catch (error) {
    logger.warn(`Could not read which images ${appUrn} uses, so none it pulls now is recorded: ${errorText(error)}`);
  }

  await pullAppImagesRecorded({ docker, files, logger }, appUrn, imageRefs, up, options);
}

/** What an uninstall does with the images on an app's record. */
export type RecordedImagesSorted = {
  /** The images no other installed app names. They go with the app. */
  removable: string[];
  /** The images another installed app names, each with one such app. They stay and {@link handOverKeptImages} moves them to it. */
  keptFor: Map<string, AppUrn>;
};

/**
 * Sorts `imageIds` by whether another installed app names them. Docker refuses only an image a container uses. Stop
 * removes an app's containers, so a stopped app holds nothing. Store apps share images widely (`postgres:16-alpine` is in
 * dozens of them). The stopped one's next start would need the registry or get whatever a moved tag names by then.
 * Reads every other app's compose, so it runs only for an uninstall with images to remove. If that can't be done, every
 * image stays, with no app to hand it to.
 */
export async function sortImagesByOtherApps(moduleRef: ModuleRef, appUrn: AppUrn, imageIds: string[]): Promise<RecordedImagesSorted> {
  if (imageIds.length === 0) {
    return { removable: [], keptFor: new Map() };
  }

  const logger = moduleRef.get(LoggerService, { strict: false });
  try {
    const files = moduleRef.get(AppFilesManager, { strict: false });
    const docker = moduleRef.get(DockerService, { strict: false });
    const architecture = moduleRef.get(ConfigurationService, { strict: false })?.get('architecture');

    // An app on its way out comes last. Its own uninstall may have read its record already, so an image handed to it can get stuck.
    const apps = (await moduleRef.get(AppsRepository, { strict: false }).getApps()).sort(
      (a, b) => Number(a.status === 'uninstalling') - Number(b.status === 'uninstalling'),
    );

    // Apps share references, so each one is looked up once however many apps name it.
    const namedBy = new Map<string, AppUrn>();
    for (const app of apps) {
      const otherUrn = createAppUrn(app.appName, app.appStoreSlug);
      if (otherUrn === appUrn) {
        continue;
      }
      // A port-expose app runs no containers. Its compose lists no services, which the parser refuses.
      if (isPortExposeApp(app.config) || isPortExposeApp(await files.getInstalledAppInfo(otherUrn))) {
        continue;
      }
      // `getDockerComposeJson` also gives no content for a file it can't read. That app could name any image.
      const { content } = await files.getDockerComposeJson(otherUrn);
      if (!content) {
        throw new Error(`the compose of ${otherUrn} can't be read`);
      }
      for (const ref of installedComposeImages(content, architecture, securityGrantsFor(otherUrn))) {
        if (!namedBy.has(ref)) {
          namedBy.set(ref, otherUrn);
        }
      }
    }

    const keptFor = new Map<string, AppUrn>();
    for (const [ref, otherUrn] of namedBy) {
      // Named in the log: this leaves images behind on every uninstall until someone changes that app.
      const imageId = await inTime(docker.imageIdLocally(ref)).catch((error: unknown) => {
        throw new Error(`${otherUrn} names ${ref}: ${errorText(error)}`);
      });
      if (imageId && imageIds.includes(imageId) && !keptFor.has(imageId)) {
        logger.info(`Keeping image ${imageId} after uninstalling ${appUrn}: ${otherUrn} uses it`);
        keptFor.set(imageId, otherUrn);
      }
    }

    return { removable: imageIds.filter((imageId) => !keptFor.has(imageId)), keptFor };
  } catch (error) {
    logger.warn(`Could not check which images other apps use, so ${appUrn} leaves its images in place: ${errorText(error)}`);
    return { removable: [], keptFor: new Map() };
  }
}

/**
 * Moves each image an uninstall keeps for another app onto that app's record, so it goes when the last app using it
 * goes, then forgets the uninstalled app's record. Each record only ever holds images some app's pull brought in, so a
 * handover can't make an image that was here before any app removable.
 *
 * Only the tags the image has now and the uninstalled app's record holds go with it. Without them the next uninstall
 * takes each for someone else's and keeps the image. With any other tag it would remove a tag a person pulled by hand.
 *
 * The other record is written first, so a failure part-way loses nothing. An image that can't be handed over stays on
 * the computer and on the uninstalled app's record, which then holds only those. Nothing here may fail the uninstall.
 */
export async function handOverKeptImages(moduleRef: ModuleRef, appUrn: AppUrn, keptFor: Map<string, AppUrn>, appTags: string[]): Promise<void> {
  const logger = moduleRef.get(LoggerService, { strict: false });
  try {
    const files = moduleRef.get(AppFilesManager, { strict: false });
    const docker = moduleRef.get(DockerService, { strict: false });
    const left: PulledImages = { imageIds: [], imageTags: [] };

    for (const [imageId, otherUrn] of keptFor) {
      let imageTags: string[] = [];
      let failure = 'its record could not be written';
      try {
        imageTags = (await inTime(docker.imageTagsLocally(imageId))).filter((tag) => appTags.includes(tag));
        if (await files.addPulledImages(otherUrn, { imageIds: [imageId], imageTags })) {
          logger.info(`Image ${imageId} now goes with ${otherUrn}`);
          continue;
        }
      } catch (error) {
        failure = errorText(error);
      }
      logger.warn(`Could not hand image ${imageId} over to ${otherUrn}, so it stays after that app goes: ${failure}`);
      left.imageIds.push(imageId);
      left.imageTags.push(...imageTags);
    }

    if (left.imageIds.length > 0) {
      if (!(await files.writePulledImages(appUrn, left))) {
        logger.warn(`Could not cut the record of the images pulled for ${appUrn} down to the ones it could not hand over`);
      }
    } else {
      await files.deletePulledImages(appUrn);
    }
  } catch (error) {
    logger.warn(`Could not finish with the record of the images pulled for ${appUrn}: ${errorText(error)}`);
  }
}
