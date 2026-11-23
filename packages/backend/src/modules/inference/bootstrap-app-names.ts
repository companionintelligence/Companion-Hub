import { CI_MARKETPLACE_STORE_SLUG } from '@/core/portal/portal.constants';
import { SUPPORTED_APP_SLUGS, type AppSlug } from './app-credentials.service';

/**
 * The installed app directory names each bootstrap slug may be running as.
 *
 * `hermes-agent` and `openclaw` are the slugs the containers fetch
 * `bootstrap.env` as, and the upstream marketplace listings; `ci-hermes` and
 * `ci-openclaw` are the first-party listings (see app-inference-requirements
 * for the same pairing). `ci-mentra` is the CI-Mentra smart-glasses bridge,
 * listed as `ci-mentra` (or `mentra`).
 *
 * Which app an installed copy BEHAVES as (`app-rehydration`) goes by these names from any store.
 * Which containers are HANDED the bootstrap credentials does not: see {@link bootstrapAppUrnsForSlug}.
 */
const BOOTSTRAP_APP_NAMES: Record<AppSlug, readonly string[]> = {
  'hermes-agent': ['hermes-agent', 'ci-hermes'],
  openclaw: ['openclaw', 'ci-openclaw'],
  'ci-mentra': ['ci-mentra', 'mentra'],
};

export function bootstrapAppNamesForSlug(slug: string): readonly string[] {
  return (SUPPORTED_APP_SLUGS as readonly string[]).includes(slug) ? BOOTSTRAP_APP_NAMES[slug as AppSlug] : [];
}

/**
 * The installed apps whose containers may fetch a slug's bootstrap credentials: those names, from the
 * official store only.
 *
 * ⚠ NOT ANY STORE. The handout is the Hub's inference key and, with cloud fallback on, the cloud
 * provider's API key. A name is the manifest's to choose, so any store's `openclaw` was handed both.
 * The store half of the URN is the Hub's record of where the app came from, which no store can claim
 * for the official one (see `isOfficialStoreApp`). An app from another store gets inference the way
 * every other app does, through `hub_integration.inference`.
 */
export function bootstrapAppUrnsForSlug(slug: string): readonly string[] {
  return bootstrapAppNamesForSlug(slug).map((name) => `${name}:${CI_MARKETPLACE_STORE_SLUG}`);
}
