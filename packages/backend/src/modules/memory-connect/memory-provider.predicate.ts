import type { AppInfo } from '@ci-hub/common/schemas';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { isOfficialStoreApp } from '@/modules/apps/official-store.predicate';

/**
 * Reserved app-directory name of the first-party Companion Memory app. Combined
 * with the store slug below it forms the provider's trusted install URN.
 */
export const CI_MEMORY_APP_ID = 'ci-memory';

/**
 * Whether an installed app is the trusted Companion Memory provider — the app
 * used as the server-to-server exchange target AND the one the Hub-global
 * forward-auth secret is injected into (app.helpers). Getting this wrong hands a
 * hostile app the master secret that authenticates every Hub→CI-Server call and
 * the Traefik identity header, so trust MUST rest on something an app cannot
 * forge.
 *
 * Trust is keyed on INSTALL PROVENANCE, read from the Hub-derived `urn`
 * (`<appName>:<appStoreSlug>`) — the store segment is recorded by the Hub at
 * install time, NOT copied from the app's config.json. We require BOTH that the
 * app directory is `ci-memory` AND that it was installed from the official
 * CI-Marketplace cloud store (`ci-marketplace`).
 *
 * The previous check keyed on `info.id`, which the schema copies verbatim from
 * config.json (it only forbids a colon) — so any app from a user-added
 * third-party store could declare `id: "ci-memory"` and be handed the forward-auth
 * secret. It cannot, however, claim the `ci-marketplace` store slug: the official
 * cloud store occupies that slug on every boot (force-converting any squatter to
 * the first-party type), so a malicious app installs as `ci-memory:<their-slug>`
 * and fails this check. `id`/`source`/`provider` are all manifest fields and are
 * intentionally not consulted. The store-slug half of the check is the shared
 * first-party gate `isOfficialStoreApp` (apps/official-store.predicate), which
 * also guards the generic trust-material provisioning in app.helpers.
 */
export function isMemoryProviderApp(info: Pick<AppInfo, 'urn'>): boolean {
  try {
    return extractAppUrn(info.urn).appName === CI_MEMORY_APP_ID && isOfficialStoreApp(info);
  } catch {
    // Malformed / missing URN → not the provider.
    return false;
  }
}
