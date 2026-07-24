import type { AppInfo } from '@ci-hub/common/schemas';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { CI_MARKETPLACE_STORE_SLUG } from '@/core/portal/portal.constants';

/**
 * Whether an installed app came from the official CI-Marketplace cloud store — the first-party
 * provenance gate for Hub-provisioned trust material (managed callback keys, per-app forward-auth
 * secrets). Getting this wrong hands a hostile app credentials that authenticate against the Hub,
 * so trust MUST rest on something an app cannot forge.
 *
 * Trust is keyed on INSTALL PROVENANCE, read from the Hub-derived `urn`
 * (`<appName>:<appStoreSlug>`) — the store segment is recorded by the Hub at install time, NOT
 * copied from the app's config.json. Manifest fields (`id`/`source`/`provider`/`hub_integration`)
 * are intentionally not consulted: any third-party manifest can declare them, but it cannot claim
 * the `ci-marketplace` store slug — the official cloud store occupies that slug on every boot
 * (force-converting any squatter to the first-party type, see app-store.service reserved slugs),
 * so a copycat app installs under `<name>:<their-slug>` and fails this check.
 */
export function isOfficialStoreApp(info: Pick<AppInfo, 'urn'>): boolean {
  try {
    return extractAppUrn(info.urn).appStoreId === CI_MARKETPLACE_STORE_SLUG;
  } catch {
    // Malformed / missing URN → no provenance → not trusted.
    return false;
  }
}
