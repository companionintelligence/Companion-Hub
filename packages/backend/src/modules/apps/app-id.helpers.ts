import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { TranslatableError } from '@/common/error/translatable-error';
import type { AppUrn } from '@ci-hub/common/types';
import { HttpStatus } from '@nestjs/common';

/**
 * Refuse an app whose id another installed app already has.
 *
 * An app's id is its name and its store's slug joined by a dash, and both may hold dashes, so app
 * `a-b` from store `c` and app `a` from store `b-c` are both `a-b-c`. The Hub names an app's Traefik
 * routers, services and middlewares by its id, and Traefik's Docker provider merges a service of one
 * name across containers and drops a router two containers define differently, so the second app
 * would take routes from the first or leave both without.
 */
export function assertAppIdFree(appUrn: AppUrn, installed: ReadonlyArray<{ appName: string; appStoreSlug: string }>): void {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  const appId = `${appName}-${appStoreId}`;
  const other = installed.find(
    (app) => `${app.appName}-${app.appStoreSlug}` === appId && (app.appName !== appName || app.appStoreSlug !== appStoreId),
  );
  if (other) {
    throw new TranslatableError(
      'APP_ERROR_APP_ID_IN_USE',
      { id: appUrn, appId, other: createAppUrn(other.appName, other.appStoreSlug) },
      HttpStatus.CONFLICT,
    );
  }
}
