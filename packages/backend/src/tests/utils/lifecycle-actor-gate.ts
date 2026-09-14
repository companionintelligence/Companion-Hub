import type { AppUrn } from '@ci-hub/common/types';
import type { HubAction } from '@/core/portal/hub-actions';
import type { ActorCheckContext, LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
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

  return (actor: LifecycleActor, appUrn: AppUrn, action: HubAction, context?: ActorCheckContext) =>
    (gate as AppLifecycleService).assertActorMay(actor, appUrn, action, context);
}

/** The actor a per-app gate must let through: a person WhoIs grants. */
export const GRANTED_ACTOR: LifecycleActor = { kind: 'operator', userId: GRANTED_USER };

/** A managed app's key at `capability`, on an app that is not the one it belongs to. */
export const managedKeyOnOtherApp = (capability: ApiKeyCapability): LifecycleActor => ({
  kind: 'mcp',
  ownerAppUrn: OTHER_APP,
  createdByUserId: null,
  capability,
});

/** The same key at `write`, the level a managed key is provisioned with: it may operate the app, not change it. */
export const MANAGED_KEY_ON_OTHER_APP: LifecycleActor = managedKeyOnOtherApp('write');

/** The actors a per-app gate must turn away from an app they hold no grant on, whatever the call. */
export const UNGRANTED_ACTORS: Array<[string, LifecycleActor]> = [
  ['an operator without the grant', { kind: 'operator', userId: UNGRANTED_USER }],
  // At `full`: a key acting as its creator gets that person's grants, whatever its own level.
  ['a key whose creator lacks the grant', { kind: 'mcp', ownerAppUrn: null, createdByUserId: UNGRANTED_USER, capability: 'full' }],
];

/** Runs `call` as the signed-in person behind an admin-runner call. */
export const asOperator = <T>(userId: number, call: () => Promise<T>): Promise<T> =>
  mcpAdminCallContext.run(() => ({ kind: 'operator', userId }), call);

/** Runs `call` inside an `/api/mcp` key's context, the way `McpController` runs a tool — at `full` unless told otherwise. */
export const asKey = <T>(
  key: Pick<ApiKeyContext, 'ownerAppUrn' | 'createdByUserId'> & Partial<Pick<ApiKeyContext, 'capability'>>,
  call: () => Promise<T>,
): Promise<T> => mcpCallContext.run({ id: 1, name: 'agent', capability: 'full', ...key }, call);

/** The same actors as {@link UNGRANTED_ACTORS}, as the MCP callers a tool resolves them from. */
export const UNGRANTED_CALLERS: Array<[string, <T>(call: () => Promise<T>) => Promise<T>]> = [
  ['an operator without the grant', (call) => asOperator(UNGRANTED_USER, call)],
  ['a key whose creator lacks the grant', (call) => asKey({ ownerAppUrn: null, createdByUserId: UNGRANTED_USER }, call)],
];

/** Runs `call` as a managed app's key on an app that is not its own, from its key's context — at `write` unless told otherwise. */
export const asManagedKeyOnOtherApp = <T>(call: () => Promise<T>, capability: ApiKeyCapability = 'write'): Promise<T> =>
  asKey({ ownerAppUrn: OTHER_APP, createdByUserId: null, capability }, call);

/** Runs `call` as {@link GRANTED_ACTOR} through the admin runner. */
export const asGrantedOperator = <T>(call: () => Promise<T>): Promise<T> => asOperator(GRANTED_USER, call);

/**
 * The checks a mocked `assertActorMay` was asked, each as `[actor, appUrn, action, context]`, with
 * `context` `undefined` where none was given — so a test pins the verb and the marker together.
 */
export const gateChecks = (gate: { mock: { calls: unknown[][] } }): unknown[][] =>
  gate.mock.calls.map(([actor, appUrn, action, context]) => [actor, appUrn, action, context]);
