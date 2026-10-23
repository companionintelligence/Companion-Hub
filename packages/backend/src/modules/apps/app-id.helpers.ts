import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { TranslatableError } from '@/common/error/translatable-error';
import type { AppUrn } from '@ci-hub/common/types';
import { HttpStatus } from '@nestjs/common';

/** An app's id: its name and its store's slug joined by a dash. The Hub names its Traefik routes by it. */
export function appIdOf(appName: string, appStoreSlug: string): string {
  return `${appName}-${appStoreSlug}`;
}

/**
 * Refuse an app whose id another installed app already has.
 *
 * Both halves of an app's id may hold dashes, so app `a-b` from store `c` and app `a` from store
 * `b-c` are both `a-b-c`. The Hub names an app's Traefik routers, services and middlewares by its
 * id. Traefik's Docker provider merges a service of one name across containers and drops a router
 * two containers define differently, so the second app would take routes from the first or leave
 * both without. Traefik reads those names without regard to case, so the ids are compared that way.
 */
export function assertAppIdFree(appUrn: AppUrn, installed: ReadonlyArray<{ appName: string; appStoreSlug: string }>): void {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  const appId = appIdOf(appName, appStoreId);
  const other = installed.find(
    (app) =>
      appIdOf(app.appName, app.appStoreSlug).toLowerCase() === appId.toLowerCase() && (app.appName !== appName || app.appStoreSlug !== appStoreId),
  );
  if (other) {
    throw new TranslatableError(
      'APP_ERROR_APP_ID_IN_USE',
      { id: appUrn, appId, other: createAppUrn(other.appName, other.appStoreSlug) },
      HttpStatus.CONFLICT,
    );
  }
}
