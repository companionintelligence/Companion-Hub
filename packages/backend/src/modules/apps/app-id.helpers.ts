import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { TranslatableError } from '@/common/error/translatable-error';
import { HUB_ROUTE_NAME_SUFFIXES } from '@/modules/docker/builders/traefik-labels.builder';
import { HUB_TRAEFIK_NAMES } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { HttpStatus } from '@nestjs/common';

/** An app's id: its name and its store's slug joined by a dash. The Hub names its Traefik routes by it. */
export function appIdOf(appName: string, appStoreSlug: string): string {
  return `${appName}-${appStoreSlug}`;
}

/**
 * Refuse an app whose id another installed app already has, or that is one of the names the Hub's
 * own Traefik routes use (`HUB_TRAEFIK_NAMES`): the Hub names the app's main router and service by
 * its id, so they would be the Hub's.
 *
 * Both halves of an app's id may hold dashes, so app `a-b` from store `c` and app `a` from store
 * `b-c` are both `a-b-c`. The Hub names an app's Traefik routers, services and middlewares by its
 * id. Traefik's Docker provider merges a service of one name across containers and drops a router
 * two containers define differently, so the second app would take routes from the first or leave
 * both without. Traefik reads those names without regard to case, so the ids are compared that way.
 *
 * The Hub also names an app's other routers and its public-host middleware by its id plus a suffix
 * (`HUB_ROUTE_NAME_SUFFIXES`), so app `x` from store `home-insecure` is refused next to app `x` from
 * store `home`: the first app's main router and the second's `-insecure` router would both be
 * `x-home-insecure`.
 */
export function assertAppIdFree(appUrn: AppUrn, installed: ReadonlyArray<{ appName: string; appStoreSlug: string }>): void {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  const appId = appIdOf(appName, appStoreId);
  const id = appId.toLowerCase();
  if (HUB_TRAEFIK_NAMES.includes(id)) {
    throw new TranslatableError('APP_ERROR_APP_ID_RESERVED', { id: appUrn, appId }, HttpStatus.CONFLICT);
  }
  const others = installed.filter((app) => app.appName !== appName || app.appStoreSlug !== appStoreId);
  const other = others.find((app) => appIdOf(app.appName, app.appStoreSlug).toLowerCase() === id);
  if (other) {
    throw new TranslatableError(
      'APP_ERROR_APP_ID_IN_USE',
      { id: appUrn, appId, other: createAppUrn(other.appName, other.appStoreSlug) },
      HttpStatus.CONFLICT,
    );
  }
  for (const app of others) {
    const otherAppId = appIdOf(app.appName, app.appStoreSlug);
    const otherId = otherAppId.toLowerCase();
    const suffix = HUB_ROUTE_NAME_SUFFIXES.find((ending) => `${id}${ending}` === otherId || `${otherId}${ending}` === id);
    if (suffix !== undefined) {
      throw new TranslatableError(
        'APP_ERROR_APP_ID_ROUTE_IN_USE',
        {
          id: appUrn,
          appId,
          other: createAppUrn(app.appName, app.appStoreSlug),
          otherAppId,
          route: id.length < otherId.length ? `${appId}${suffix}` : `${otherAppId}${suffix}`,
        },
        HttpStatus.CONFLICT,
      );
    }
  }
}
