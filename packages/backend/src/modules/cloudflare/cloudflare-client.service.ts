import { APP_DIR, DATA_DIR, DEFAULT_CI_CLOUD_URL, TUNNEL_DIR, detectContainerDataRoot, tunnelUserClearedMarkerPath } from '@/common/constants';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerReadFacade } from '../docker/docker-read.facade';
import { DockerService } from '../docker/docker.service';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import type { AvailableCustomDomain, AvailableDomain, AvailableDomainsResponse, TunnelCustomDomain } from '@ci-hub/common/types';
import { parseAvailableCustomDomains, parseTunnelCustomDomains } from '@ci-hub/common/types';
import axios, { AxiosInstance, type AxiosResponse } from 'axios';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { writeHealableTextFile } from '@/common/helpers/bind-mount-helpers';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, withPortalAxiosHeaders } from '@/common/helpers/portal-url';
import { PortalClientService } from '@/core/portal/portal-client.service';

/** How long `getDeviceApplications` waits for the Portal before it counts as no answer. */
const DEVICE_APPLICATIONS_TIMEOUT_MS = 15_000;

export interface AppInfo {
  name: string;
  subdomain: string; // Complete Cloudflare public-hostname prefix, such as `n8n-bdc`.
  publicDomain?: string; // Selected public root domain for this app hostname.
  localPort: number;
  protocol?: 'http' | 'https';
  hostname?: string;
  originServerName?: string; // HTTP Host header sent to Traefik, such as `n8n-bdc.ci.lan`.
  /**
   * Distinguishes infrastructure entries that Companion Portal must preserve
   * across regular app synchronization.
   *
   * An undefined value represents a regular user app eligible for stale-app
   * cleanup. Companion Portal stores other values in
   * `application.privileged_kind` and excludes those rows from sync pruning, so
   * a later payload omission cannot remove a required Cloudflare tunnel route.
   *
   * - `hub`: The Companion Hub application row. The Portal omits this entry from
   *   generated ingress rules and reconstructs its route from the database so
   *   `host.docker.internal:{port}` uses the authoritative port.
   * - `vpn`: A legacy value retained for compatibility with older Portal rows.
   *   Companion Hub no longer synchronizes Headscale routes.
   *
   * This discriminator replaces the `isHub` and `isVpn` flags. See CI-Portal
   * migration 0017.
   */
  privilegedKind?: 'hub' | 'vpn';
  /**
   * Provides the authoritative Hub API listen port for `privilegedKind === 'hub'`.
   *
   * Companion Portal stores this value on the Hub application row so tunnel
   * routes follow desktop port remapping.
   */
  hubListenPort?: number;
}

/**
 * Describes why Companion Portal could not write an app's public DNS record.
 *
 * - `conflict`: Another device, tunnel, or non-tunnel DNS record owns the
 *   hostname. Companion Portal does not overwrite it, and retries cannot resolve
 *   the conflict.
 * - `zone_unreachable`: The selected domain's zone is not provisioned for this
 *   device in the Portal environment.
 * - `api_error`: Cloudflare rejected the write, usually because of a transient error.
 * - `invalid_subdomain`: The requested subdomain contains no valid DNS label, so
 *   Companion Portal rejected it before Cloudflare was ever involved.
 */
export type PublicDnsFailureReason = 'conflict' | 'zone_unreachable' | 'api_error' | 'invalid_subdomain';

export interface PublicDnsFailure {
  app: string;
  hostname?: string;
  reason: PublicDnsFailureReason;
  message?: string;
}

/**
 * Describes the outcome of a Companion Portal state synchronization.
 *
 * `ok` reports whether the request succeeded. `failed` lists apps whose public
 * DNS records the Portal could not create during a partially applied sync.
 * Callers must surface a nonempty list because those apps will not resolve.
 */
export interface CloudflareSyncResult {
  ok: boolean;
  failed: string[];
  /**
   * Provides per-app failure details when Companion Portal supports them.
   *
   * `failed` remains the source of truth for app identity, and callers use
   * generic messaging when this list is empty.
   */
  failures: PublicDnsFailure[];
  synced: number;
  /**
   * Lists custom hostnames that Companion Portal reports as wired to this tunnel.
   *
   * `undefined` and `[]` have different meanings. `undefined` indicates that the
   * Portal does not report custom domains, either because its version predates
   * the feature or because the sync failed. Callers must preserve existing
   * bindings. An empty array confirms that the device has none and instructs
   * callers to unbind them.
   */
  customDomains?: TunnelCustomDomain[];
  /** Provides the Portal HTTP status when the control-plane request fails. */
  errorStatus?: number;
  /** Provides a concise, user-safe reason for a full sync failure. */
  errorMessage?: string;
}

export interface PortalDeviceApplication {
  id: string;
  name: string;
  slug: string;
  port: number;
  publicDomain: string | null;
}

@Injectable()
export class CloudflareClientService {
  private readonly logger = new Logger(CloudflareClientService.name);
  private readonly cloudApiUrl: string;
  private readonly client: AxiosInstance;
  private tunnelToken: string | null = null;
  private tunnelId: string | null = null;

  constructor(
    private configService: ConfigurationService,
    private moduleRef: ModuleRef,
    private portalClient: PortalClientService,
  ) {
    const publicCiCloudUrl = this.configService.get('ciCloudUrl') || DEFAULT_CI_CLOUD_URL;
    const ciCloudUrl = this.configService.getOutboundCiCloudUrl() || DEFAULT_CI_CLOUD_URL;
    this.cloudApiUrl = `${ciCloudUrl}/api`;

    this.client = axios.create({
      baseURL: this.cloudApiUrl,
      ...withPortalAxiosHeaders(buildPortalAxiosConfig(publicCiCloudUrl, readPortalInternalUrlOverride()), {
        'Content-Type': 'application/json',
      }),
    });
  }

  private getRequestConfig() {
    return {
      headers: this.portalClient.getDeviceAuthHeaders(),
    };
  }

  private isAvailableDomain(entry: unknown): entry is AvailableDomain {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const candidate = entry as Partial<AvailableDomain> & { id?: string | number };

    return (
      (typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
      typeof candidate.domain === 'string' &&
      typeof candidate.isDefault === 'boolean' &&
      (typeof candidate.scope === 'string' || typeof candidate.scope === 'undefined')
    );
  }

  private async updateTunnelFiles(token: string) {
    // Tests can override the default `APP_DIR` location through `CI_HUB_TUNNEL_DIR`.
    const tunnelDir = TUNNEL_DIR;
    const certsDir = path.join(tunnelDir, 'certs');

    try {
      this.logger.debug(`Writing tunnel token to: ${tunnelDir}`);
      await fs.mkdir(tunnelDir, { recursive: true });
      await fs.mkdir(certsDir, { recursive: true });

      // `cloudflared` reads this token through its Docker Compose configuration.
      await writeHealableTextFile(path.join(tunnelDir, 'token'), token, 0o644);
      try {
        await fs.unlink(tunnelUserClearedMarkerPath());
      } catch {
        // User-cleared marker may not exist.
      }
      this.logger.log('Wrote tunnel token to file');
    } catch (e) {
      this.logger.error(`Failed to write tunnel files: ${e}`);
      throw e;
    }
  }

  /** Initializes a tunnel with credentials received during Portal registration. */
  async initializeTunnel(
    organizationId: string,
    credentials: { tunnelId: string; token: string },
  ): Promise<{ tunnelId: string; token: string } | null> {
    try {
      this.logger.log(`Configuring tunnel for org: ${organizationId}...`);

      if (credentials?.token) {
        this.tunnelId = credentials.tunnelId;
        this.tunnelToken = credentials.token;

        await this.updateTunnelFiles(this.tunnelToken);

        const domain = this.configService.get('domain');
        if (domain === 'ci.localhost') {
          this.logger.log('Local/E2E mode — skipping cloudflared container start');
          return { tunnelId: this.tunnelId, token: this.tunnelToken };
        }

        this.logger.log('Ensuring cloudflared container is running...');
        const dockerService = this.moduleRef.get(DockerService, { strict: false });
        const composeFile = await this.getComposeFile();
        await dockerService.ensureContainerRunning('cloudflared', {
          composeFile,
          profile: 'cloudflare',
        });
        this.logger.log('Cloudflared container is running.');

        this.logger.log(`Tunnel configured successfully: ${this.tunnelId}`);
        return { tunnelId: this.tunnelId, token: this.tunnelToken };
      }

      this.logger.error(`No credentials provided for tunnel initialization for org ${organizationId}`);
      return null;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to configure tunnel: ${error.message}`);
      } else {
        this.logger.error(`Failed to configure tunnel: ${String(error)}`);
      }
      return null;
    }
  }

  /**
   * Sends running-app state to Companion Portal for Cloudflare tunnel and DNS
   * reconciliation.
   */
  async syncState(organizationId: string, apps: AppInfo[], tunnelId?: string): Promise<CloudflareSyncResult> {
    if (tunnelId) {
      this.tunnelId = tunnelId;
    }

    if (!this.tunnelId) {
      this.logger.warn('Cannot sync state: Tunnel not initialized and no tunnelId provided');
      return {
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Tunnel not initialized',
      };
    }

    const maxAttempts = 3;
    let lastError: CloudflareSyncResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.syncStateOnce(organizationId, apps);
      if (result.ok) {
        return result;
      }
      lastError = result;
      const transient =
        result.errorStatus === undefined ||
        result.errorStatus >= 500 ||
        result.errorMessage?.toLowerCase().includes('timeout') ||
        result.errorMessage?.toLowerCase().includes('network');
      if (!transient || attempt === maxAttempts) {
        return result;
      }
      this.logger.warn(
        `Cloudflare state sync attempt ${attempt}/${maxAttempts} failed (${result.errorStatus ?? 'n/a'}: ${result.errorMessage ?? 'unknown'}); retrying…`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }

    return lastError ?? { ok: false, failed: [], failures: [], synced: 0, errorMessage: 'State sync failed' };
  }

  private async syncStateOnce(organizationId: string, apps: AppInfo[]): Promise<CloudflareSyncResult> {
    const tunnelId = this.tunnelId;
    if (!tunnelId) {
      return {
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Tunnel not initialized',
      };
    }

    try {
      this.logger.log(`Syncing ${apps.length} apps to CI-Cloud (Tunnel: ${tunnelId})...`);
      this.logger.log(`Sync Payload: ${JSON.stringify({ organizationId, tunnelId, apps }, null, 2)}`);
      const responseData = await this.portalClient.postTunnelState({
        organizationId,
        tunnelId,
        apps,
      });
      const response = { data: responseData };

      this.logger.log(`Sync Response: ${JSON.stringify(response.data)}`);

      if (response.data.success) {
        // Companion Portal returns `failed` app names and a count of created DNS
        // records in `synced`. A partially applied sync requires a warning because
        // the affected apps cannot load at their public domains.
        //
        // Validate each element at this boundary between independently deployed
        // services. A malformed `failures` entry could throw during mapping and
        // reach this method's catch, converting a partial sync into a hard failure.
        // That result would make the UI notify every exposed app instead of only
        // those that failed, so discard malformed entries without changing the
        // request verdict.
        const failed: string[] = Array.isArray(response.data.failed)
          ? response.data.failed.filter((name): name is string => typeof name === 'string')
          : [];
        // Require `reason` because an absent value would render as `undefined`.
        // Accept unknown strings so a newer Companion Portal can add a class
        // without breaking older consumers, which already use a generic fallback.
        const failures: PublicDnsFailure[] = Array.isArray(response.data.failures)
          ? response.data.failures.filter(
              (failure): failure is PublicDnsFailure =>
                typeof failure === 'object' && failure !== null && typeof failure.app === 'string' && typeof failure.reason === 'string',
            )
          : [];
        const synced: number | undefined = typeof response.data.synced === 'number' ? response.data.synced : undefined;
        // Apply the same wire-boundary validation to `customDomains`, while
        // preserving field absence. An older Companion Portal omits this field,
        // and converting that state to an empty array would tell consumers to
        // remove domains that still serve traffic. `parseTunnelCustomDomains`
        // returns `undefined` for absence and `{ entries: [] }` for a confirmed
        // empty set, preserving the distinction through persistence.
        const parsedCustomDomains = parseTunnelCustomDomains(response.data.customDomains);

        if (parsedCustomDomains && parsedCustomDomains.dropped > 0) {
          const dropped = parsedCustomDomains.dropped;
          this.logger.warn(
            `[Cloudflare] Dropped ${dropped} malformed custom-domain ${dropped === 1 ? 'entry' : 'entries'} from the tunnel state response; the rest of the sync is unaffected.`,
          );
        }

        if (failed.length > 0) {
          // Report the per-app cause instead of attributing every failure to zone
          // provisioning. DNS conflicts require different remediation
          // (CI-Portal#403).
          //
          // Build the list from `failed` and enrich it with available details.
          // `failures` can omit apps when an older Portal sends no details, a newer
          // one sends an incomplete list, or validation discards malformed entries.
          // Using it as the source would name fewer apps than `failed.length` and
          // hide the failures with the least diagnostic detail.
          const failureByApp = new Map(failures.map((failure) => [failure.app, failure]));
          const detail = failed
            .map((name) => {
              const failure = failureByApp.get(name);

              return failure ? `${name} (${failure.reason}: ${failure.message ?? 'no detail'})` : name;
            })
            .join(', ');

          this.logger.warn(
            `[Cloudflare] State sync only partially applied: ${failed.length} app(s) did NOT get a public DNS record and will not load at their public domain: ${detail}.` +
              (failures.length > 0
                ? ''
                : " Verify the selected domain's zone is reachable in this environment (see CI-Cloud DNS logs for the underlying Cloudflare error)."),
          );
        } else {
          this.logger.log(`State sync successful${synced === undefined ? '' : ` (${synced} DNS record(s) synced)`}`);
        }

        return { ok: true, failed, failures, synced: synced ?? 0, customDomains: parsedCustomDomains?.entries };
      }
      return {
        ok: false,
        failed: [],
        failures: [],
        synced: 0,
        errorMessage: 'Portal returned success=false for tunnel state sync',
      };
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to sync state: ${error.message}`);
      } else {
        this.logger.error(`Failed to sync state: ${String(error)}`);
      }
      let errorStatus: number | undefined;
      let errorMessage = error instanceof Error ? error.message : String(error);
      if (axios.isAxiosError(error) && error.response) {
        errorStatus = error.response.status;
        this.logger.error(`Error Response: ${JSON.stringify(error.response.data)}`);
        const body = error.response.data as { error?: string } | undefined;
        if (typeof body?.error === 'string' && body.error.trim()) {
          errorMessage = body.error;
        } else if (errorStatus === 401 || errorStatus === 403) {
          errorMessage = 'Device auth/tunnel ownership rejected — re-pair this Hub with CI Portal';
        } else if (errorStatus >= 500) {
          errorMessage = `Portal/Cloudflare control-plane error (${errorStatus})`;
        }
      }
      return { ok: false, failed: [], failures: [], synced: 0, errorStatus, errorMessage };
    }
  }

  /**
   * Fetch user-installed applications recorded in CI Portal for this device.
   *
   * Throws when the Portal gives no answer — unreachable, an error status, or a payload without an
   * `applications` list. This used to read as an empty list, and an empty list is an answer: a restore
   * that got it installed nothing, recorded itself as done, and let the next sync release every app the
   * Portal still had for the device.
   *
   * The request has a timeout because this client sets none. After a pairing, app sync stays held
   * until this read answers (`PairingAppRestoreService`), so a connection that never answers (a laptop
   * that slept mid-request, a dropped NAT mapping) would hold it for good instead of retrying.
   */
  async getDeviceApplications(): Promise<PortalDeviceApplication[]> {
    let applications: unknown;
    try {
      const response = await this.client.get<{ applications?: PortalDeviceApplication[] }>('devices/applications', {
        ...this.getRequestConfig(),
        timeout: DEVICE_APPLICATIONS_TIMEOUT_MS,
      });
      applications = response.data?.applications;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to fetch Portal device applications: ${message}`);
      throw new Error(`Could not read this device's apps from CI Portal: ${message}`);
    }

    if (!Array.isArray(applications)) {
      this.logger.error('Failed to fetch Portal device applications: the response carried no applications list');
      throw new Error("Could not read this device's apps from CI Portal: the response carried no applications list");
    }

    return applications as PortalDeviceApplication[];
  }

  /**
   * Returns connected custom domains and their binding states for the install
   * dialog.
   *
   * A listed domain exists, but an app may emit only a domain reported in
   * `customDomains` by the tunnel-state response. That response remains the only
   * source for `app.custom_domain`. The Hub cannot verify that a hostname resolves
   * to its tunnel, so it must not build a public URL from an unconfirmed domain.
   *
   * `undefined` means the request could not produce an authoritative answer, such
   * as when an older Portal returns 404, the Portal is unreachable, or the payload
   * is invalid. An empty array means the organization owns no domains. Preserving
   * this distinction prevents the dialog from claiming an empty account after a
   * failed request.
   */
  async fetchOrganizationCustomDomains(organizationId?: string): Promise<AvailableCustomDomain[] | undefined> {
    try {
      const { status, data } = await this.portalClient.fetchDeviceCustomDomains(organizationId ?? (await this.resolveOrganizationId()));

      if (status === 404) {
        // A Companion Portal version that predates custom domains has no listing
        // route. Treat that supported deployment like an unreachable Portal:
        // neither provides an authoritative list.
        this.logger.debug('[Cloudflare] This CI-Cloud does not serve the device custom-domain listing');

        return undefined;
      }

      if (status < 200 || status >= 300) {
        this.logger.warn(`[Cloudflare] Could not list custom domains: CI-Cloud answered ${status}`);

        return undefined;
      }

      const domains = parseAvailableCustomDomains(data?.domains);

      if (!domains) {
        this.logger.warn('[Cloudflare] CI-Cloud answered the custom-domain listing with a payload that could not be read');

        return undefined;
      }

      this.logger.debug(`Fetched ${domains.length} custom domain(s) from CI-Cloud`);

      return domains;
    } catch (error) {
      this.logger.warn(`[Cloudflare] Could not list custom domains: ${error instanceof Error ? error.message : String(error)}`);

      return undefined;
    }
  }

  /**
   * Resolves the organization represented by the Hub for callers such as the
   * install dialog.
   *
   * Companion Portal refuses to choose an arbitrary tenant when an incomplete
   * transfer leaves a device registered to multiple organizations. Omitting the
   * ID in that state makes the listing unavailable even though the background
   * binding pass, which sends an ID, succeeds. Match sync behavior by preferring
   * the configured organization and otherwise using the Hub's registration.
   */
  private async resolveOrganizationId(): Promise<string | undefined> {
    try {
      const registrations = this.moduleRef.get(DeviceRegistrationRepository, { strict: false });
      const configured = this.configService.getConfig().ciHubOrganizationId;
      const row = configured ? await registrations.getDeviceRegistrationById(configured) : null;

      return (row ?? (await registrations.getFirstDeviceRegistration()))?.id;
    } catch {
      // An unregistered Hub has no organization to identify. Companion Portal can
      // still answer an unqualified request for a single-tenant device.
      return undefined;
    }
  }

  /**
   * Asks Companion Portal to point a connected domain at an app on this device.
   *
   * A successful request changes no local state. The app learns about the alias
   * only after a later sync reports it in `customDomains`, which updates
   * `app.custom_domain` and requests a restart. Writing the binding before Portal
   * confirmation could make the Hub emit a public URL that the edge refused.
   *
   * The result includes a failure reason so callers can retain and retry intents
   * that can become valid, such as an unregistered app or verifying domain, and
   * clear terminal intents for domains that no longer exist.
   */
  async bindCustomDomain(
    domainId: string,
    appSlug: string,
    organizationId?: string,
  ): Promise<{ ok: true; targetHostname?: string } | { ok: false; status?: number; code?: string; message: string }> {
    try {
      const { status, data } = await this.portalClient.postDeviceCustomDomainBind({ domainId, appSlug, organizationId });

      if (status >= 200 && status < 300) {
        return { ok: true, targetHostname: typeof data?.targetHostname === 'string' ? data.targetHostname : undefined };
      }

      return {
        ok: false,
        status,
        code: typeof data?.code === 'string' ? data.code : undefined,
        message: typeof data?.error === 'string' ? data.error : `CI-Cloud answered ${status}`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Ask CI-Cloud to stop serving a custom domain on this device.
   *
   * ⚠ THIS PARKS THE DOMAIN; IT DOES NOT GIVE IT UP. CI-Cloud clears the
   * routing and the Cloudflare origin and leaves the row, the ownership proof
   * and the certificate intact — the same shape connect-first/bind-later
   * creates. The organization keeps the domain and can point it at another app
   * with an ordinary bind; nothing here needs a person in the Entri modal.
   *
   * Disconnecting a domain is still a session-and-managing-role act in the
   * portal, and no Hub path reaches it.
   *
   * `DOMAIN_NOT_FOUND` is reported as SUCCESS. A Hub that parks a domain and
   * loses the response asks again and finds nothing to park — which is the state
   * it asked for. Treating that as a failure would leave the operator's choice
   * pending forever against a domain that has already stopped serving.
   */
  async unbindCustomDomain(
    domainId: string,
    appSlug: string,
    organizationId?: string,
  ): Promise<{ ok: true } | { ok: false; status?: number; code?: string; message: string }> {
    try {
      const { status, data } = await this.portalClient.postDeviceCustomDomainUnbind({ domainId, appSlug, organizationId });

      if (status >= 200 && status < 300) {
        return { ok: true };
      }

      const code = typeof data?.code === 'string' ? data.code : undefined;

      if (code === 'DOMAIN_NOT_FOUND') {
        return { ok: true };
      }

      return {
        ok: false,
        status,
        code,
        message: typeof data?.error === 'string' ? data.error : `CI-Cloud answered ${status}`,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async fetchAvailableDomains(): Promise<AvailableDomainsResponse> {
    try {
      const requestConfig = this.getRequestConfig();
      let response: AxiosResponse<{ domains?: unknown[] }>;

      // Companion Portal serves the domain list at `/api/domains`. Retain the
      // namespaced fallback for compatibility with alternate route layouts.
      try {
        response = await this.client.get('domains', requestConfig);
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status !== 404) {
          throw error;
        }

        this.logger.warn('CI-Cloud domains endpoint returned 404, retrying cloudflare/domains fallback');
        response = await this.client.get('cloudflare/domains', requestConfig);
      }

      const domains = Array.isArray(response.data?.domains)
        ? response.data.domains
            .filter((entry: unknown): entry is AvailableDomain => this.isAvailableDomain(entry))
            .map((entry: AvailableDomain) => ({ ...entry, id: String(entry.id) }))
        : [];

      this.logger.debug(`Fetched ${domains.length} domain(s) from CI-Cloud`);

      return { domains };
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to fetch available domains: ${error.message}`);
      } else {
        this.logger.error(`Failed to fetch available domains: ${String(error)}`);
      }
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`Domain fetch error response: ${JSON.stringify(error.response.data)}`);
      }

      return { domains: [] };
    }
  }

  async checkDnsAvailability(subdomain: string, domain?: string): Promise<{ available: boolean; message?: string }> {
    try {
      const response = await this.client.get('cloudflare/check-dns-availability', {
        ...this.getRequestConfig(),
        params: {
          subdomain,
          ...(domain ? { domain } : {}),
        },
      });

      if (typeof response.data?.available === 'boolean') {
        return {
          available: response.data.available,
          message: typeof response.data?.message === 'string' ? response.data.message : undefined,
        };
      }

      return {
        available: false,
        message: 'Unable to verify DNS availability (unexpected CI-Cloud response)',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : axios.isAxiosError(error)
            ? [error.code, error.response?.status, error.response?.statusText].filter(Boolean).join(' ') || 'CI-Cloud request failed'
            : String(error);

      this.logger.error(`Failed to check DNS availability: ${errorMessage}`);

      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`DNS availability error response: ${JSON.stringify(error.response.data)}`);
      }

      const errorData = (error as { response?: { data?: { message?: unknown; error?: unknown } } })?.response?.data;
      const responseMessage =
        typeof errorData?.message === 'string' ? errorData.message : typeof errorData?.error === 'string' ? errorData.error : '';

      if (axios.isAxiosError(error) && !error.response) {
        this.logger.warn('CI-Cloud DNS availability check timed out or was unreachable; failing open');
        return {
          available: true,
          message: 'Unable to verify DNS availability right now. Please try again.',
        };
      }

      const message = responseMessage || 'Unable to verify DNS availability right now. Please try again.';

      return {
        available: false,
        message,
      };
    }
  }

  getTunnelId(): string | null {
    return this.tunnelId;
  }

  getTunnelToken(): string | null {
    return this.tunnelToken;
  }

  /**
   * Loads the tunnel token from disk and optionally restores the registered
   * tunnel ID.
   *
   * Startup must restore this in-memory state because the token file survives a
   * process restart while `getTunnelToken()` does not.
   */
  async loadTunnelTokenFromDisk(tunnelId?: string | null): Promise<boolean> {
    try {
      if (tunnelId) {
        this.tunnelId = tunnelId;
      }
      const tokenPath = path.join(TUNNEL_DIR, 'token');
      const token = await fs.readFile(tokenPath, 'utf-8');
      const trimmed = token?.trim();
      if (trimmed) {
        // Periodic registration validation reloads this file. Log only a changed
        // value so healthy Hubs do not produce repeated warnings.
        const changed = this.tunnelToken !== trimmed;
        this.tunnelToken = trimmed;
        if (changed) {
          this.logger.log(`Loaded tunnel token from disk (${trimmed.length} chars, tunnelId=${this.tunnelId ?? 'none'})`);
        }
        return true;
      }
      this.logger.warn('Tunnel token file exists but is empty');
    } catch (err) {
      this.logger.error(`Failed to read tunnel token from disk: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /**
   * Forgets the tunnel credentials held in memory and removes the `cloudflared`
   * container.
   *
   * Deleting the token file alone does not disconnect a running connector, which
   * keeps serving the old hostname until its container stops. Returns false when
   * the container could not be removed, so the caller can try again.
   */
  async stopTunnel(): Promise<boolean> {
    this.tunnelToken = null;
    this.tunnelId = null;

    // Local and E2E stacks never start `cloudflared`. A development backend on a
    // machine that also runs a real Hub must not remove that Hub's connector.
    if (this.configService.get('domain') === 'ci.localhost') {
      return true;
    }

    try {
      const dockerService = this.moduleRef.get(DockerService, { strict: false });
      if (!dockerService) {
        this.logger.warn('stopTunnel: DockerService unavailable');
        return false;
      }

      const owned = await this.ownsCloudflaredContainer();
      if (owned === null) {
        this.logger.warn('stopTunnel: could not check which Hub started cloudflared');
        return false;
      }
      if (!owned) {
        this.logger.warn(
          'stopTunnel: leaving cloudflared alone because Docker Compose started it from another folder, so it belongs to another Hub on this machine',
        );
        return true;
      }

      return await dockerService.removeContainer('cloudflared');
    } catch (error) {
      this.logger.warn(`stopTunnel: could not remove cloudflared: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Starts or restarts `cloudflared` idempotently when a token is available.
   *
   * A registered Hub calls this method on each boot because
   * `recoverTunnelTokenFromDb` starts `cloudflared` only when the token file is
   * missing. Without this additional check, restarting a registered Hub with an
   * existing file would leave the tunnel down. An unregistered Hub never reaches
   * this method at boot. Local and E2E modes skip the container.
   */
  async ensureCloudflaredRunning(options: { forceRestart?: boolean } = {}): Promise<boolean> {
    if (!this.tunnelToken) {
      this.logger.warn('ensureCloudflaredRunning: skipped — no tunnel token in memory');
      return false;
    }
    const domain = this.configService.get('domain');
    if (domain === 'ci.localhost') {
      this.logger.warn('Local/E2E mode — not ensuring cloudflared container');
      return false;
    }
    try {
      const dockerReadFacade = this.moduleRef.get(DockerReadFacade, { strict: false });
      const dockerService = this.moduleRef.get(DockerService, { strict: false });

      const alreadyRunning = dockerReadFacade ? await dockerReadFacade.isContainerRunning('cloudflared') : false;
      if (alreadyRunning && !options.forceRestart) {
        this.logger.debug('ensureCloudflaredRunning: cloudflared is already running, skipping restart');
        return true;
      }

      if (!dockerService) {
        this.logger.warn('ensureCloudflaredRunning: DockerService unavailable');
        return false;
      }

      if (alreadyRunning && options.forceRestart) {
        this.logger.warn('ensureCloudflaredRunning: restarting cloudflared after tunnel credential recovery...');
        try {
          await dockerService.restartContainer('cloudflared');
          this.logger.warn('Cloudflared container restarted with recovered credentials.');
          return true;
        } catch (restartError) {
          this.logger.warn(
            `ensureCloudflaredRunning: restart failed (${restartError instanceof Error ? restartError.message : String(restartError)}); falling through to recreate`,
          );
        }
      }

      this.logger.warn('Ensuring cloudflared container is running (post-boot)...');
      const composeFile = this.getComposeFile();
      await dockerService.ensureContainerRunning('cloudflared', {
        composeFile,
        profile: 'cloudflare',
      });
      this.logger.warn('Cloudflared container is running.');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ensure cloudflared is running: ${msg}`);
      return false;
    }
  }

  /**
   * Resolves the Docker Compose file used to start `cloudflared`.
   *
   * The bundled Hub mounts the active file at `${DATA_DIR}/docker-compose.yml`,
   * matching `DockerService.getBaseComposeArgsHub`. Local `pnpm dev` and tests
   * fall back to the repository source file. Do not gate the mounted path on
   * `NODE_ENV`: `.env.dev` sets `NODE_ENV=development` inside the bundled image,
   * which would select the nonexistent `/app/docker-compose.local.yml`.
   */
  /**
   * Whether the `cloudflared` container on this Docker engine is this Hub's to remove.
   *
   * Inside the Hub container it is: that engine runs this one Hub. A backend run from a source
   * checkout shares the engine with the rest of the machine, often an installed Hub whose
   * connector has the same container name, and `DOMAIN` stops marking local mode once pairing
   * writes the Portal's domain. So there only a container that Compose started from this
   * backend's compose folder counts. Compose records that folder as a host path, which a process
   * on the host can compare. A missing container counts as this Hub's, since there is nothing to
   * remove. Returns null when Docker could not be asked.
   */
  private async ownsCloudflaredContainer(): Promise<boolean | null> {
    if (this.runsInsideHubContainer()) {
      return true;
    }

    const dockerReadFacade = this.moduleRef.get(DockerReadFacade, { strict: false });
    if (!dockerReadFacade) {
      return null;
    }

    const label = await dockerReadFacade.readContainerLabel('cloudflared', 'com.docker.compose.project.working_dir');
    if (label === null) {
      return null;
    }
    if (!label.found) {
      return true;
    }
    if (!label.value) {
      return false;
    }

    const normalize = (dir: string) => {
      const resolved = path.resolve(dir);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(label.value) === normalize(path.dirname(this.getComposeFile()));
  }

  /** Split out so tests can run the source-checkout rules on any machine. */
  private runsInsideHubContainer(): boolean {
    return detectContainerDataRoot();
  }

  private getComposeFile(): string {
    const mounted = path.join(DATA_DIR, 'docker-compose.yml');
    if (fsSync.existsSync(mounted)) {
      return mounted;
    }

    const isLocal = process.env.LOCAL === 'true' || process.env.NODE_ENV === 'development';
    const isStaging = process.env.NODE_ENV === 'staging';

    let filename = 'docker-compose.prod.yml';
    if (isLocal) {
      filename = 'docker-compose.local.yml';
    } else if (isStaging) {
      filename = 'docker-compose.staging.yml';
    }

    return path.join(APP_DIR, filename);
  }
}
