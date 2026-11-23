import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsReadService } from '@/modules/apps/apps-read.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { DockerService } from '@/modules/docker/docker.service';
import { appUrnLabelSets, listContainersMatchingAnyLabelSets } from '@/modules/docker/hub-container-query';
import { isMemoryProviderApp } from '@/modules/memory-connect/memory-provider.predicate';
import { nextAppLinkSubnet } from '@/modules/network/app-network-addresses';
import { AppLinkApprovalRepository } from './app-link-approval.repository';
import { type AppLinkPlan, appLinkNetworkName, isActiveLink, planAppLinks } from './app-link-plan';

/** Labels on every link network, so a reconcile finds its own and nothing else. */
export const APP_LINK_LABEL = 'ci-hub.app-link';
const APP_LINK_CONSUMER_LABEL = 'ci-hub.app-link.consumer';
const APP_LINK_PROVIDER_LABEL = 'ci-hub.app-link.provider';

/** ci-memory's gateway service when its manifest names none (see `MemoryProviderResolver`). */
const DEFAULT_MEMORY_SERVICE = 'gateway';

/** How often links are checked against what is running, besides after every app `up`. */
const RECONCILE_INTERVAL_MS = 2 * 60_000;

type LinkNetwork = { Id?: string; Name?: string; Labels?: Record<string, string> | null };
type ListedContainer = { Id?: string; Names?: string[]; State?: string; Labels?: Record<string, string>; HostConfig?: { NetworkMode?: string } };

/**
 * Builds the networks that link one app to another, and takes them down again.
 *
 * Each app is on a Docker network of its own (see "App networks" in docs/system/backend.md). An app that
 * reaches another app directly does so over a link network made for the two: the consumer's running
 * containers, and the one provider service it names, under the name the consumer reaches it by. Which
 * links exist is decided by {@link planAppLinks}: Companion Memory consumers to ci-memory's gateway,
 * and the links two manifests declare to each other, made by themselves within one store and
 * otherwise only once the operator allows them.
 *
 * The Hub connects every member itself, so the only name on a link network is the one the Hub gave the
 * provider's service there. A consumer cannot add one, and so cannot answer the provider's own lookups.
 * Link networks are `internal`: they carry the two apps' traffic to each other and nothing else.
 *
 * Containers are recreated by `compose up`, which drops what was connected in place, so links are
 * re-made after every app `up` (`DockerService.onAppNetworksSettled`), at boot, and every two minutes.
 */
@Injectable()
export class AppLinkService implements OnApplicationBootstrap, OnModuleDestroy {
  private reconciling: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private warnedApple = false;

  constructor(
    private readonly logger: LoggerService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly dockerService: DockerService,
    private readonly appsReadService: AppsReadService,
    private readonly approvals: AppLinkApprovalRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.dockerService.onAppNetworksSettled(() => this.reconcile());
    this.timer = setInterval(() => {
      void this.reconcile();
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Every link the installed apps ask for, with whether it is in force. */
  async plan(): Promise<AppLinkPlan[]> {
    const installed = await this.appsReadService.getInstalledApps();
    const apps = installed.map(({ info }) => ({ urn: info.urn as AppUrn, hubIntegration: info.hub_integration }));
    const memoryApp = installed.find(({ info }) => isMemoryProviderApp(info));
    const memory = memoryApp
      ? { appUrn: memoryApp.info.urn as AppUrn, service: memoryApp.info.hub_integration?.memory?.provider?.service ?? DEFAULT_MEMORY_SERVICE }
      : null;
    return planAppLinks(apps, memory, await this.approvals.list());
  }

  /** Allows a link that waits for the operator. Throws when no such link is declared. */
  async approve(consumerUrn: AppUrn, providerUrn: AppUrn, approvedByUserId: number | null): Promise<AppLinkPlan[]> {
    const plan = (await this.plan()).find((entry) => entry.consumerUrn === consumerUrn && entry.providerUrn === providerUrn);
    if (!plan || (plan.status !== 'needs-approval' && plan.status !== 'approved')) {
      throw new Error(`${consumerUrn} does not ask to reach ${providerUrn}, or needs no approval to`);
    }
    await this.approvals.approve({ consumerUrn, providerUrn, service: plan.service, alias: plan.alias, approvedByUserId });
    this.logger.info(`[AppLinks] ${consumerUrn} may reach ${providerUrn}'s ${plan.service} as ${plan.alias} (operator approval)`);
    await this.reconcile();
    return this.plan();
  }

  /** Withdraws an operator's approval; the link goes down now. */
  async revoke(consumerUrn: AppUrn, providerUrn: AppUrn): Promise<AppLinkPlan[]> {
    if (await this.approvals.revoke(consumerUrn, providerUrn)) {
      this.logger.info(`[AppLinks] ${consumerUrn} may no longer reach ${providerUrn} (approval withdrawn)`);
    }
    await this.reconcile();
    return this.plan();
  }

  /** Forgets every approval naming an app, when it is uninstalled. Never throws. */
  async forgetApp(appUrn: AppUrn): Promise<void> {
    try {
      await this.approvals.forgetApp(appUrn);
    } catch (error) {
      this.logger.warn(`[AppLinks] Could not forget the link approvals of ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.reconcile();
  }

  /**
   * Makes the link networks match {@link plan}: creates the missing ones, connects members that are not on
   * them, disconnects anything that should not be, and removes the networks of links no longer in force.
   * Calls that arrive while one runs are folded into one more pass. Never throws.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.again = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.again = false;
        try {
          await this.reconcileOnce();
        } catch (error) {
          this.logger.warn(`[AppLinks] Reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (this.again);
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<void> {
    if (await this.dockerService.isAppleContainerEngine()) {
      if (!this.warnedApple) {
        this.warnedApple = true;
        this.logger.warn(
          '[AppLinks] Not linking apps to each other: Apple container cannot attach a running container to a network, so apps that reach another app directly (Companion Memory consumers among them) cannot.',
        );
      }
      return;
    }

    const active = (await this.plan()).filter(isActiveLink);
    const desired = new Map(active.map((plan) => [appLinkNetworkName(plan), plan]));
    const existing = await this.listLinkNetworks();

    for (const network of existing) {
      if (network.Name && !desired.has(network.Name)) {
        await this.removeLinkNetwork(network);
      }
    }

    const existingNames = new Set(existing.map((network) => network.Name));
    for (const [name, plan] of desired) {
      try {
        await this.ensureLink(name, plan, existingNames.has(name));
      } catch (error) {
        this.logger.warn(
          `[AppLinks] Could not link ${plan.consumerUrn} to ${plan.providerUrn}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async ensureLink(name: string, plan: AppLinkPlan, exists: boolean): Promise<void> {
    const consumers = (await this.runningContainers(plan.consumerUrn)).filter(hasOwnNetworkStack);
    const providers = (await this.runningContainers(plan.providerUrn, plan.service)).filter(hasOwnNetworkStack);

    // Nothing to link until both ends run. A network left from before stays for when they do.
    if (!exists && (consumers.length === 0 || providers.length === 0)) {
      return;
    }
    if (!exists) {
      const subnet = nextAppLinkSubnet(await this.occupiedSubnets());
      if (!subnet) {
        this.logger.warn(`[AppLinks] No free link subnet left in 10.128.1.0–10.128.9.255; ${plan.consumerUrn} cannot reach ${plan.providerUrn}`);
        return;
      }
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Internal: true,
        IPAM: { Config: [{ Subnet: subnet }] },
        Labels: { [APP_LINK_LABEL]: 'true', [APP_LINK_CONSUMER_LABEL]: plan.consumerUrn, [APP_LINK_PROVIDER_LABEL]: plan.providerUrn },
      });
      this.logger.info(
        `[AppLinks] Created ${name} (${subnet}) linking ${plan.consumerUrn} to ${plan.providerUrn}'s ${plan.service} as ${plan.alias}`,
      );
    }

    const network = this.docker.getNetwork(name);
    const inspected = (await network.inspect()) as { Containers?: Record<string, { Name?: string }> | null };
    const members = new Set(Object.keys(inspected?.Containers ?? {}));

    const wanted = new Map<string, string[]>();
    for (const container of consumers) {
      if (container.Id) wanted.set(container.Id, []);
    }
    for (const container of providers) {
      if (container.Id) wanted.set(container.Id, [plan.alias]);
    }

    for (const [id, aliases] of wanted) {
      if (members.has(id)) {
        continue;
      }
      try {
        await network.connect({ Container: id, EndpointConfig: { Aliases: aliases } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          this.logger.warn(`[AppLinks] Could not connect ${id.slice(0, 12)} to ${name}: ${message}`);
        }
      }
    }

    // Anything else on it was not put there by this link: a container the Hub put there before the
    // app's compose changed, or one connected by hand. Only the two apps belong.
    for (const id of members) {
      if (wanted.has(id)) {
        continue;
      }
      try {
        await network.disconnect({ Container: id, Force: true });
      } catch (error) {
        this.logger.warn(
          `[AppLinks] Could not disconnect ${id.slice(0, 12)} from ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async removeLinkNetwork(network: LinkNetwork): Promise<void> {
    if (!network.Id || !network.Name) {
      return;
    }
    try {
      const handle = this.docker.getNetwork(network.Id);
      const inspected = (await handle.inspect()) as { Containers?: Record<string, unknown> | null };
      for (const id of Object.keys(inspected?.Containers ?? {})) {
        await handle.disconnect({ Container: id, Force: true }).catch(() => undefined);
      }
      await handle.remove();
      this.logger.info(
        `[AppLinks] Removed ${network.Name}: ${network.Labels?.[APP_LINK_CONSUMER_LABEL] ?? 'an app'} no longer reaches ${network.Labels?.[APP_LINK_PROVIDER_LABEL] ?? 'the other'}`,
      );
    } catch (error) {
      this.logger.warn(`[AppLinks] Could not remove ${network.Name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async listLinkNetworks(): Promise<LinkNetwork[]> {
    const listed = await this.docker.listNetworks({ filters: { label: [`${APP_LINK_LABEL}=true`] } });
    return Array.isArray(listed) ? listed : [];
  }

  /** Every IPv4 subnet Docker has, so a new link network overlaps none of them. */
  private async occupiedSubnets(): Promise<string[]> {
    const listed = (await this.docker.listNetworks()) as Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> | null } }>;
    return listed.flatMap((network) =>
      (network.IPAM?.Config ?? []).flatMap((config) => (config.Subnet && !config.Subnet.includes(':') ? [config.Subnet] : [])),
    );
  }

  /** The app's running containers, or only those of one compose service. */
  private async runningContainers(appUrn: AppUrn, service?: string): Promise<ListedContainer[]> {
    const containers = (await listContainersMatchingAnyLabelSets(
      this.docker,
      appUrnLabelSets(appUrn, service ? [`com.docker.compose.service=${service}`] : []),
      false,
    )) as ListedContainer[];
    return containers.filter((container) => container.State === 'running');
  }
}

/**
 * Whether a container has a network stack of its own to connect. One on the host's network, on none, or
 * sharing another container's (`network_mode: service:…` reads as `container:<id>`) cannot be.
 */
function hasOwnNetworkStack(container: ListedContainer): boolean {
  const mode = container.HostConfig?.NetworkMode ?? '';
  return mode !== 'host' && mode !== 'none' && !mode.startsWith('container:');
}
