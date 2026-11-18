import { createHash } from 'node:crypto';
import type { HubIntegration } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { MEMORY_LINK_ALIAS } from '@/modules/memory-connect/memory-consumer-url';
import { APP_LINK_NETWORK_PREFIX } from '@/modules/network/network-constants';

/** An installed app as the planner needs it. */
export interface LinkPlanApp {
  urn: AppUrn;
  hubIntegration?: HubIntegration;
}

/** ci-memory's gateway, when ci-memory is installed. */
export interface LinkPlanMemoryProvider {
  appUrn: AppUrn;
  service: string;
}

/** An operator's stored leave for a link (`app_link_approval`). */
export interface LinkPlanApproval {
  consumerUrn: string;
  providerUrn: string;
  service: string;
  alias: string;
}

/**
 * Why a link is in force, or why it waits:
 *
 * - `memory`: a Companion Memory consumer reaching ci-memory's gateway. Made for every app that
 *   declares the Memory integration; the user's consent is the key, which the Hub hands over only
 *   when they connect the app, and the gateway refuses everything without one.
 * - `mutual`: both apps name each other and come from the same store.
 * - `approved`: the operator allowed it.
 * - `needs-approval`: declared, but across two stores or by one side only, and not allowed yet.
 * - `provider-missing`: the app it names is not installed.
 */
export type AppLinkStatus = 'memory' | 'mutual' | 'approved' | 'needs-approval' | 'provider-missing';

export interface AppLinkPlan {
  consumerUrn: AppUrn;
  providerUrn: AppUrn;
  /** The provider's compose service the consumer reaches. */
  service: string;
  /** The name the consumer reaches it by. */
  alias: string;
  status: AppLinkStatus;
  /** For `needs-approval`: whether the provider names the consumer back. */
  reciprocal: boolean;
  sameStore: boolean;
}

/** Whether a link is in force: the Hub builds its network. */
export function isActiveLink(plan: AppLinkPlan): boolean {
  return plan.status === 'memory' || plan.status === 'mutual' || plan.status === 'approved';
}

/**
 * Every link the installed apps ask for, and whether each is in force.
 *
 * A declared link (`hub_integration.links`) is in force when both apps name each other by app and
 * store and come from the same store, or when the operator allowed exactly that service under that
 * name. Nothing else is: a manifest cannot reach an app that did not ask for it, and a store cannot
 * reach another store's apps without the operator. See the field's own description in
 * `@ci-hub/common/schemas` app-info.
 */
export function planAppLinks(
  apps: readonly LinkPlanApp[],
  memory: LinkPlanMemoryProvider | null,
  approvals: readonly LinkPlanApproval[],
): AppLinkPlan[] {
  const byUrn = new Map(apps.map((app) => [app.urn as string, app]));
  const plans = new Map<string, AppLinkPlan>();

  for (const app of apps) {
    const { appStoreId: store } = extractAppUrn(app.urn);

    const consumesMemory = Boolean(app.hubIntegration?.memory?.url_env && app.hubIntegration?.memory?.token_env);
    if (memory && consumesMemory && app.urn !== memory.appUrn) {
      plans.set(linkKey(app.urn, memory.appUrn), {
        consumerUrn: app.urn,
        providerUrn: memory.appUrn,
        service: memory.service,
        alias: MEMORY_LINK_ALIAS,
        status: 'memory',
        reciprocal: true,
        sameStore: extractAppUrn(memory.appUrn).appStoreId === store,
      });
    }

    for (const target of app.hubIntegration?.links?.connects_to ?? []) {
      const providerUrn = createAppUrn(target.app, target.store ?? store);
      if (providerUrn === app.urn || plans.has(linkKey(app.urn, providerUrn))) {
        continue;
      }
      const alias = target.alias ?? target.app;
      const provider = byUrn.get(providerUrn);
      const providerStore = extractAppUrn(providerUrn).appStoreId;
      const sameStore = providerStore === store;
      const reciprocal = Boolean(
        provider?.hubIntegration?.links?.accepts_from?.some((from) => createAppUrn(from.app, from.store ?? providerStore) === app.urn),
      );
      const approved = approvals.some(
        (row) => row.consumerUrn === app.urn && row.providerUrn === providerUrn && row.service === target.service && row.alias === alias,
      );
      const status: AppLinkStatus = provider ? (reciprocal && sameStore ? 'mutual' : approved ? 'approved' : 'needs-approval') : 'provider-missing';
      plans.set(linkKey(app.urn, providerUrn), { consumerUrn: app.urn, providerUrn, service: target.service, alias, status, reciprocal, sameStore });
    }
  }

  return [...plans.values()].sort((a, b) => linkKey(a.consumerUrn, a.providerUrn).localeCompare(linkKey(b.consumerUrn, b.providerUrn)));
}

function linkKey(consumerUrn: string, providerUrn: string): string {
  return `${consumerUrn}>${providerUrn}`;
}

/**
 * The Docker network a link lives on. Named from the two apps and the service, hashed: URN halves may
 * hold characters a network name cannot, and the name must be the same on every reconcile.
 */
export function appLinkNetworkName(plan: Pick<AppLinkPlan, 'consumerUrn' | 'providerUrn' | 'service' | 'alias'>): string {
  const digest = createHash('sha256').update(`${plan.consumerUrn}\n${plan.providerUrn}\n${plan.service}\n${plan.alias}`).digest('hex').slice(0, 16);
  return `${APP_LINK_NETWORK_PREFIX}${digest}`;
}
