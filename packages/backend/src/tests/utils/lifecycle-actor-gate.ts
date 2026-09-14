import type { AppUrn } from '@ci-hub/common/types';
import type { HubAction } from '@/core/portal/hub-actions';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { mcpAdminCallContext, mcpCallContext } from '@/modules/mcp/mcp-call-context';

/** The person the default WhoIs below grants every verb on every app. */
export const GRANTED_USER = 7;
/** A person it grants nothing. */
export const UNGRANTED_USER = 9;
/** The app a managed key belongs to — never the app a test acts on. */
export const OTHER_APP = 'importer:ci-marketplace';

type Grants = (userId: number, appUrn: AppUrn, action: HubAction) => boolean;

/**
 * `AppLifecycleService.assertActorMay` itself, not a stand-in for it, over a WhoIs that answers from
 * `granted`. For a test whose subject asks the lifecycle's actor gate while the rest of the lifecycle
 * is mocked, so the refusal it sees is the one the Hub gives.
 */
export function lifecycleActorGate(granted: Grants = (userId) => userId === GRANTED_USER): AppLifecycleService['assertActorMay'] {
  const whois = { has: async (userId: number, appUrn: AppUrn, action: HubAction) => granted(userId, appUrn, action) };
  // The real prototype over a bare instance: the gate reads nothing but WhoIs, through `moduleRef`.
  const gate = Object.create(AppLifecycleService.prototype);
  gate.moduleRef = { get: (token: unknown) => (token === MarketplaceWhoIsService ? whois : undefined) };

  return (actor: LifecycleActor, appUrn: AppUrn, action: HubAction) => (gate as AppLifecycleService).assertActorMay(actor, appUrn, action);
}

/** The actor a per-app gate must let through: a person WhoIs grants. */
export const GRANTED_ACTOR: LifecycleActor = { kind: 'operator', userId: GRANTED_USER };

/** The actors a per-app gate must turn away from an app they have no grant on. */
export const REFUSED_ACTORS: Array<[string, LifecycleActor]> = [
  ['an operator without the grant', { kind: 'operator', userId: UNGRANTED_USER }],
  ['a managed key on another app', { kind: 'mcp', ownerAppUrn: OTHER_APP, createdByUserId: null }],
  ['a key whose creator lacks the grant', { kind: 'mcp', ownerAppUrn: null, createdByUserId: UNGRANTED_USER }],
];

/** Runs `call` as the signed-in person behind an admin-runner call. */
export const asOperator = <T>(userId: number, call: () => Promise<T>): Promise<T> =>
  mcpAdminCallContext.run(() => ({ kind: 'operator', userId }), call);

/** Runs `call` inside an `/api/mcp` key's context, the way `McpController` runs a tool. */
export const asKey = <T>(key: Pick<ApiKeyContext, 'ownerAppUrn' | 'createdByUserId'>, call: () => Promise<T>): Promise<T> =>
  mcpCallContext.run({ id: 1, name: 'agent', capability: 'full', ...key }, call);

/** The same refused actors as {@link REFUSED_ACTORS}, as the MCP callers a tool resolves them from. */
export const REFUSED_CALLERS: Array<[string, <T>(call: () => Promise<T>) => Promise<T>]> = [
  ['an operator without the grant', (call) => asOperator(UNGRANTED_USER, call)],
  ['a managed key on another app', (call) => asKey({ ownerAppUrn: OTHER_APP, createdByUserId: null }, call)],
  ['a key whose creator lacks the grant', (call) => asKey({ ownerAppUrn: null, createdByUserId: UNGRANTED_USER }, call)],
];

/** Runs `call` as {@link GRANTED_ACTOR} through the admin runner. */
export const asGrantedOperator = <T>(call: () => Promise<T>): Promise<T> => asOperator(GRANTED_USER, call);
