import path from 'node:path';

/**
 * Index of the last complete CI Marketplace sync, written next to `repos/ci-marketplace/apps/`.
 *
 * The `apps/` folder alone cannot say which app folders are in the current catalog: the sync
 * never deletes a folder when Portal stops listing an app, and installs write their own files
 * into the same folder. The index records exactly the slugs Portal's `/store` listing returned,
 * and which Portal returned them, so the local catalog fallback serves nothing else.
 */
export const CATALOG_SNAPSHOT_INDEX_FILE = 'catalog-index.json';

/**
 * The full store listing is one large response Portal builds on demand; it has taken 16–37s.
 * The sync is a background job, so this is a ceiling for a slow Portal, not a request-path wait.
 */
export const CI_CLOUD_STORE_LISTING_TIMEOUT_MS = 45_000;

export type CatalogSnapshotIndex = {
  version: 1;
  /** The app store URL the listing came from (`<portal>/api`). */
  source: string;
  syncedAt: number;
  slugs: string[];
};

/** Slugs become folder names; anything that could leave `apps/` is not a slug. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

export function isSafeCatalogSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SAFE_SLUG.test(slug) && !slug.includes('..');
}

export function catalogSnapshotIndexPath(repoPath: string): string {
  return path.join(repoPath, CATALOG_SNAPSHOT_INDEX_FILE);
}

export function buildCatalogSnapshotIndex(source: string, apps: Array<{ id?: unknown; slug?: unknown }>, now = Date.now()): CatalogSnapshotIndex {
  const slugs = new Set<string>();
  for (const app of apps) {
    const slug = app.slug || app.id;
    if (isSafeCatalogSlug(slug)) {
      slugs.add(slug);
    }
  }
  return { version: 1, source, syncedAt: now, slugs: [...slugs] };
}

export function parseCatalogSnapshotIndex(raw: unknown): CatalogSnapshotIndex | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.source !== 'string' || typeof value.syncedAt !== 'number' || !Array.isArray(value.slugs)) {
    return null;
  }
  return {
    version: 1,
    source: value.source,
    syncedAt: value.syncedAt,
    slugs: value.slugs.filter(isSafeCatalogSlug),
  };
}
