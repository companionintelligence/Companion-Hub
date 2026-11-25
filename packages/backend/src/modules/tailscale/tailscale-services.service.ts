import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { resolveHubComposeFile } from '@/common/helpers/hub-compose-file';
import { DockerService } from '../docker/docker.service';
import { TAILSCALE_SERVICES_SCOPES, TailscaleAdminApiService, TailscaleApiError } from './tailscale-admin-api.service';
import { TailscaleService, type TailscaleStatus } from './tailscale.service';
import {
  DEFAULT_TAILSCALE_SERVICES_TAG,
  isValidTailscaleTag,
  type PublishedTailscaleService,
  serviceLabelFor,
  type TailscaleOAuthClient,
  tailscaleServicesStore,
} from './tailscale-services.store';

/** Hosting a Service needs Tailscale 1.86 or later on the host. */
const MIN_SERVICES_VERSION: readonly [number, number] = [1, 86];

/** Why Services are not in use, in words the settings page shows as they are. */
export type TailscaleServicesBlocker = 'not-set-up' | 'node-not-running' | 'node-signed-out' | 'node-not-tagged' | 'node-too-old' | 'tailnet-unknown';

export interface TailscaleServicesStatus {
  /** An OAuth client is known (saved in the Hub, or the env pair). */
  configured: boolean;
  /** Whether the client came from the Hub's setup (it can be removed there) rather than the env. */
  savedInHub: boolean;
  tag: string;
  /** Services are published for VPN apps. False: they keep the per-port addresses. */
  ready: boolean;
  blocker: TailscaleServicesBlocker | null;
  node: {
    running: boolean;
    nodeFqdn: string | null;
    tags: string[];
    version: string | null;
  };
  /** The address each VPN app answers on through its Service. */
  services: Array<{ appUrn: AppUrn; name: string; url: string }>;
}

/** One VPN app the sync wants on a Service. */
export interface DesiredTailscaleService {
  appUrn: AppUrn;
  /** The app's subdomain or name; the Service label is made from it. */
  label: string;
}

/** What one sync pass got: the apps now on a Service. The rest stay on their per-port listeners. */
export interface TailscaleServicesSyncResult {
  published: Map<AppUrn, PublishedTailscaleService>;
  /** The hostnames Traefik routes; the caller writes them with each app's target. */
  ready: boolean;
}

function versionAtLeast(version: string | null, [wantMajor, wantMinor]: readonly [number, number]): boolean {
  const match = version?.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * Tailscale Services for Private VPN apps: each app on its own `https://<label>.<tailnet>.ts.net/`.
 *
 * Today's per-port addresses (`https://<node>.<tailnet>.ts.net:<port>/`) share one hostname, so
 * every app there gets every other app's cookies, and Serve hands each port straight to the app's
 * container with no Hub login. A Service has its own hostname, and the Hub's node sends it to
 * Traefik, where the app's route carries the Hub login like every other route.
 *
 * Tailscale's rules shape the setup:
 * - Only a TAGGED device can host a Service, so the Hub's own `hub-tailscale` node joins as one
 *   (`TailscaleService.joinServicesNodeTagged`), never the host's client.
 * - Each Service must be defined in the tailnet and each host approved. With the operator's OAuth
 *   client (scopes {@link TAILSCALE_SERVICES_SCOPES}) the Hub does both through the API.
 * - Who may reach a Service is the tailnet policy's business: the operator's grants decide.
 *
 * Until all of that holds, VPN apps keep their per-port addresses ({@link status} says why).
 */
@Injectable()
export class TailscaleServicesService {
  private readonly logger = new Logger(TailscaleServicesService.name);
  /** Services whose host approval the API confirmed this process, so a pass does not ask again. */
  private readonly approved = new Set<string>();
  /** The blocker last logged, so a standing one is logged once. */
  private lastLoggedBlocker: TailscaleServicesBlocker | null | undefined;

  constructor(
    private readonly tailscale: TailscaleService,
    private readonly adminApi: TailscaleAdminApiService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * The operator's setup: tests the OAuth client, saves it, starts the Hub's node and signs it in
   * as `tag`. Throws with what went wrong; nothing is saved unless the client works.
   */
  async setUp(input: { clientId: string; clientSecret: string; tag?: string }): Promise<TailscaleServicesStatus> {
    const tag = input.tag?.trim() || DEFAULT_TAILSCALE_SERVICES_TAG;
    if (!isValidTailscaleTag(tag)) {
      throw new Error(`"${tag}" is not a Tailscale tag. Tags look like tag:ci-hub.`);
    }
    const client: TailscaleOAuthClient = { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), tag };
    if (!client.clientId || !client.clientSecret) {
      throw new Error('Enter the OAuth client ID and secret.');
    }
    if (!client.clientSecret.startsWith('tskey-client-')) {
      throw new Error('That secret is not an OAuth client secret. Those start with tskey-client-.');
    }

    try {
      await this.adminApi.getAccessToken(TAILSCALE_SERVICES_SCOPES.join(' '), client);
    } catch (error) {
      throw new Error(
        `Tailscale did not accept that OAuth client for the scopes ${TAILSCALE_SERVICES_SCOPES.join(', ')}. ` +
          `Check the ID and secret, and that the client has all three scopes and the tag ${tag}. (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    await tailscaleServicesStore.saveOAuthClient(client);
    this.adminApi.forgetTokens();
    this.approved.clear();

    await this.startNode();
    const node = await this.tailscale.getServicesNodeStatus();
    if (!(node.connected && node.tags?.includes(tag))) {
      this.logger.log(`[Tailscale Services] Signing the Hub's node in as ${tag}`);
      await this.tailscale.joinServicesNodeTagged(client.clientSecret, tag);
    }
    return this.status();
  }

  /**
   * Stops using Services: removes every Service the Hub defined, and forgets a client saved in the
   * Hub. VPN apps go back to their per-port addresses on the next sync. The node stays signed in.
   */
  async turnOff(): Promise<TailscaleServicesStatus> {
    const published = tailscaleServicesStore.publishedServices();
    for (const [appUrn, service] of published) {
      await this.removeService(service).catch((error) =>
        this.logger.warn(
          `[Tailscale Services] Could not remove ${service.name} (${appUrn}): ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    await tailscaleServicesStore.savePublished(new Map(), null);
    await tailscaleServicesStore.forgetOAuthClient();
    this.adminApi.forgetTokens();
    this.approved.clear();
    return this.status();
  }

  async status(): Promise<TailscaleServicesStatus> {
    const client = tailscaleServicesStore.readOAuthClient();
    const node = await this.tailscale.getServicesNodeStatus();
    const blocker = this.blockerFor(client, node);
    const published = tailscaleServicesStore.publishedServices();
    return {
      configured: client !== null,
      savedInHub: tailscaleServicesStore.hasSavedOAuthClient(),
      tag: client?.tag ?? DEFAULT_TAILSCALE_SERVICES_TAG,
      ready: blocker === null,
      blocker,
      node: {
        running: node.installed,
        nodeFqdn: node.nodeFqdn,
        tags: node.tags ?? [],
        version: node.version,
      },
      services: [...published].map(([appUrn, service]) => ({ appUrn, name: service.name, url: `https://${service.fqdn}/` })),
    };
  }

  /**
   * One pass: defines, serves and approves a Service for each desired app, and removes the Hub's
   * Services for apps that left. `hubOrigin` is the Hub dashboard on the tailnet, which a Service's
   * login redirect needs. A pass that cannot use Services publishes nothing and removes nothing:
   * the apps fall back to their per-port addresses and their Services wait for the next pass.
   */
  async sync(desired: DesiredTailscaleService[], hubOrigin: string | null): Promise<TailscaleServicesSyncResult> {
    const previous = tailscaleServicesStore.publishedServices();
    const client = tailscaleServicesStore.readOAuthClient();
    if (!client) {
      this.logBlocker('not-set-up');
      return { published: new Map(), ready: false };
    }
    const node = await this.tailscale.getServicesNodeStatus();
    const blocker = this.blockerFor(client, node);
    this.logBlocker(blocker);
    if (blocker || !node.tailnet || !node.stableNodeId) {
      return { published: new Map(), ready: false };
    }

    const installId = await tailscaleServicesStore.installId();
    const marker = `Managed by CI-Hub (${installId})`;
    const upstream = this.tailscale.getServicesUpstream();
    const serveConfig = await this.tailscale.getServicesNodeServeConfig().catch(() => new Map<string, unknown>());
    const published = new Map<AppUrn, PublishedTailscaleService>();
    const taken = new Set<string>();

    for (const want of desired) {
      const before = previous.get(want.appUrn);
      try {
        const service = await this.ensureService(want, before, { client, node, marker, upstream, serveConfig, taken });
        if (service) {
          published.set(want.appUrn, service);
          taken.add(service.name);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A failed check is not the app leaving. Dropping it here sent the cleanup below to delete a
        // Service that was working: one Tailscale API call that timed out took the app off its
        // address until the next pass. So it keeps its Service as it was, and the next pass checks
        // again; only an app that is no longer wanted loses its Service.
        if (before) {
          published.set(want.appUrn, before);
          taken.add(before.name);
          this.logger.warn(`[Tailscale Services] ${want.appUrn} keeps ${before.name} as it was; checking it again on the next pass: ${reason}`);
        } else {
          this.logger.warn(`[Tailscale Services] ${want.appUrn} stays on its per-port address: ${reason}`);
        }
      }
    }

    for (const [appUrn, service] of previous) {
      if (published.get(appUrn)?.name === service.name) continue;
      await this.removeService(service).catch((error) =>
        this.logger.warn(`[Tailscale Services] Could not remove ${service.name}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }

    await tailscaleServicesStore.savePublished(published, hubOrigin);
    return { published, ready: true };
  }

  private async ensureService(
    want: DesiredTailscaleService,
    previous: PublishedTailscaleService | undefined,
    ctx: {
      client: TailscaleOAuthClient;
      node: TailscaleStatus;
      marker: string;
      upstream: string;
      serveConfig: Map<string, unknown>;
      taken: Set<string>;
    },
  ): Promise<PublishedTailscaleService | null> {
    const label = serviceLabelFor(want.label);
    if (!label) {
      throw new Error(`"${want.label}" leaves no usable Service name`);
    }
    const nodeLabel = serviceLabelFor(ctx.node.hostname ?? '') || 'hub';
    // The app's own name first; when another Hub or person already has it, this Hub's node name after it.
    const candidates = previous ? [previous.name] : [`svc:${label}`, `svc:${serviceLabelFor(`${label}-${nodeLabel}`)}`];

    let name: string | null = null;
    for (const candidate of candidates) {
      if (ctx.taken.has(candidate)) continue;
      const existing = await this.adminApi.getService(candidate);
      if (existing && existing.comment !== ctx.marker) {
        this.logger.debug(`[Tailscale Services] ${candidate} belongs to someone else; trying the next name`);
        continue;
      }
      if (!(existing?.ports?.includes('tcp:443') && existing.tags?.includes(ctx.client.tag))) {
        await this.adminApi.putService({
          name: candidate,
          comment: ctx.marker,
          ports: ['tcp:443'],
          tags: [ctx.client.tag],
        });
        this.logger.log(`[Tailscale Services] Defined ${candidate} for ${want.appUrn}`);
      }
      name = candidate;
      break;
    }
    if (!name) {
      throw new Error(`every name tried (${candidates.join(', ')}) belongs to someone else on the tailnet`);
    }

    const served = ctx.serveConfig.get(name);
    if (!served || !JSON.stringify(served).includes(ctx.upstream)) {
      await this.tailscale.serveService(name, ctx.upstream);
    }

    const stableNodeId = ctx.node.stableNodeId as string;
    if (!this.approved.has(name)) {
      const hosts = await this.adminApi.listServiceHosts(name);
      const self = hosts.find((host) => host.stableNodeID === stableNodeId);
      if (!self?.approvalLevel?.startsWith('approved')) {
        await this.adminApi.approveServiceHost(name, stableNodeId);
        this.logger.log(`[Tailscale Services] Approved this Hub's node to host ${name}`);
      }
      this.approved.add(name);
    }

    return { name, fqdn: `${name.slice('svc:'.length)}.${ctx.node.tailnet}`.toLowerCase() };
  }

  private async removeService(service: PublishedTailscaleService): Promise<void> {
    await this.tailscale.clearServiceOnServicesNode(service.name);
    const marker = `Managed by CI-Hub (${await tailscaleServicesStore.installId()})`;
    const existing = await this.adminApi.getService(service.name).catch((error: unknown) => {
      if (error instanceof TailscaleApiError && error.status === 403) return null;
      throw error;
    });
    // Only a Service this install defined is deleted; one someone took over since stays.
    if (existing?.comment === marker) {
      await this.adminApi.deleteService(service.name);
    }
    this.approved.delete(service.name);
    this.logger.log(`[Tailscale Services] Removed ${service.name}`);
  }

  private blockerFor(client: TailscaleOAuthClient | null, node: TailscaleStatus): TailscaleServicesBlocker | null {
    if (!client) return 'not-set-up';
    if (!node.installed) return 'node-not-running';
    if (!node.connected) return 'node-signed-out';
    if (!node.tags?.includes(client.tag)) return 'node-not-tagged';
    if (!versionAtLeast(node.version, MIN_SERVICES_VERSION)) return 'node-too-old';
    if (!node.tailnet) return 'tailnet-unknown';
    return null;
  }

  private logBlocker(blocker: TailscaleServicesBlocker | null): void {
    if (blocker === this.lastLoggedBlocker) return;
    this.lastLoggedBlocker = blocker;
    if (blocker === null) {
      this.logger.log('[Tailscale Services] In use: Private VPN apps get their own Tailscale Service');
    } else if (blocker !== 'not-set-up') {
      this.logger.warn(`[Tailscale Services] Not in use (${blocker}); Private VPN apps keep their per-port addresses`);
    }
  }

  /** Starts `hub-tailscale` from the Hub's compose file, as the Cloudflare setup starts `cloudflared`. */
  private async startNode(): Promise<void> {
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    if (!dockerService) {
      throw new Error('Cannot start the Hub’s Tailscale container: the Docker service is unavailable');
    }
    await dockerService.ensureContainerRunning(process.env.TAILSCALE_SIDECAR_CONTAINER ?? 'hub-tailscale', {
      composeFile: resolveHubComposeFile(),
      profile: 'private-vpn',
    });
    await this.tailscale.waitForServicesNode();
  }
}
