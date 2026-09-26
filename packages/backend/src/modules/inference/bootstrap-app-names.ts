import { SUPPORTED_APP_SLUGS, type AppSlug } from './app-credentials.service';

/**
 * The installed app directory names each bootstrap slug may be running as.
 *
 * `hermes-agent` and `openclaw` are the slugs the containers fetch
 * `bootstrap.env` as, and the upstream marketplace listings; `ci-hermes` and
 * `ci-openclaw` are the first-party listings (see app-inference-requirements
 * for the same pairing). Any store: the question the guard asks is "is the
 * caller one of THIS app's containers", not "is this app official".
 */
const BOOTSTRAP_APP_NAMES: Record<AppSlug, readonly string[]> = {
  'hermes-agent': ['hermes-agent', 'ci-hermes'],
  openclaw: ['openclaw', 'ci-openclaw'],
};

export function bootstrapAppNamesForSlug(slug: string): readonly string[] {
  return (SUPPORTED_APP_SLUGS as readonly string[]).includes(slug) ? BOOTSTRAP_APP_NAMES[slug as AppSlug] : [];
}
