import type { AppInfo } from '@ci-hub/common/schemas';

/**
 * Reserved, first-party app id of Companion Memory (CI-Server). The Hub installs
 * this app itself, and provider trust — which app is used as the server-to-server
 * exchange target AND which app the Hub-global forward-auth secret is injected
 * into — is pinned to this id.
 *
 * It is deliberately NOT derived from a manifest-declared role: keying on
 * `hub_integration.memory.provider` would let ANY app self-declare itself the
 * provider and be handed the forward-auth shared secret (which also protects the
 * Traefik identity header), so that fallback is intentionally absent here.
 */
export const CI_MEMORY_APP_ID = 'ci-memory';

/**
 * Whether an installed app is the trusted Companion Memory provider. Pure
 * function of the manifest id so the resolver and env generation agree on one
 * definition (no drift, single trust boundary).
 */
export function isMemoryProviderApp(info: Pick<AppInfo, 'id'>): boolean {
  return info.id === CI_MEMORY_APP_ID;
}
