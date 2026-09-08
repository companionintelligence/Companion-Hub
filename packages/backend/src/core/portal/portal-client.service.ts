import { TranslatableError } from '@/common/error/translatable-error';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import type { PublicDnsFailure } from '@/modules/cloudflare/cloudflare-client.service';
import type { TunnelCustomDomain } from '@ci-hub/common/types';
import * as crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const DEFAULT_OFFLINE_ENTITLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OfflineEntitlementPayload {
  appId: string;
  appUrn?: string;
  organizationId?: string;
  orgId?: string;
  deviceId?: string;
  entitled?: boolean;
  issuedAt?: string | number;
  iat?: number;
  expiresAt?: string | number;
  exp?: number;
  gracePeriodMs?: number;
  gracePeriodSeconds?: number;
  features?: string[];
  [key: string]: unknown;
}

export interface VerifyOfflineEntitlementOptions {
  publicKey?: string | KeyObject;
  gracePeriodMs?: number;
  currentTime?: number | Date | string;
  expectedAppId?: string;
  expectedDeviceId?: string;
}

export interface OfflineEntitlementVerificationResult {
  valid: boolean;
  entitled: boolean;
  reason?:
    | 'valid'
    | 'grace_period'
    | 'expired'
    | 'invalid_signature'
    | 'invalid_token'
    | 'app_mismatch'
    | 'device_mismatch'
    | 'missing_public_key'
    | 'invalid_key'
    | string;
  inGracePeriod: boolean;
  payload?: OfflineEntitlementPayload;
  expiresAt?: Date;
  graceExpiresAt?: Date;
  error?: string;
}

export type PortalStoreListingsParams = {
  category?: string;
  tags?: string;
  sort?: 'newest' | 'trending';
  q?: string;
};

export type PortalWhoIsApp = {
  appId: string;
  entitled?: boolean;
  can?: string[];
  capMap?: Record<string, unknown>;
};

export type PortalWhoIsResponse = {
  organizations: Array<{
    organizationId: string;
    version?: number;
    source?: string;
    apps: PortalWhoIsApp[];
  }>;
};

@Injectable()
export class PortalClientService {
  private readonly publicPortalUrl: string;
  private readonly outboundPortalUrl: string;
  private readonly apiClient: AxiosInstance;

  constructor(private readonly configuration: ConfigurationService) {
    const { ciCloudUrl } = this.configuration.getConfig();
    const publicUrl = (ciCloudUrl ?? '').trim().replace(/\/+$/, '');
    this.publicPortalUrl = publicUrl;
    this.outboundPortalUrl = publicUrl ? resolveOutboundPortalBaseUrl(publicUrl, readPortalInternalUrlOverride()) : '';
    this.apiClient = axios.create({
      baseURL: this.outboundPortalUrl ? `${this.outboundPortalUrl}/api` : undefined,
      timeout: 30_000,
      ...(publicUrl ? buildPortalAxiosConfig(publicUrl, readPortalInternalUrlOverride()) : {}),
    });
  }

  getPublicPortalUrl(): string {
    return this.publicPortalUrl;
  }

  getOutboundPortalUrl(): string {
    return this.outboundPortalUrl;
  }

  requirePortalUrl(): string {
    if (!this.publicPortalUrl) {
      throw new TranslatableError('PORTAL_URL_NOT_CONFIGURED', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.publicPortalUrl;
  }

  getDeviceAuthHeaders(): Record<string, string> {
    const token = this.configuration.get('ciHubApiKey');
    if (!token) {
      return {};
    }
    return {
      Authorization: `Bearer ${token}`,
      'x-device-key': token,
    };
  }

  async fetchJson<T = unknown>(path: string, init?: { authenticated?: boolean; params?: Record<string, string>; bypassCache?: boolean }): Promise<T> {
    this.requirePortalUrl();
    const headers: Record<string, string> = init?.authenticated ? this.getDeviceAuthHeaders() : {};
    if (init?.bypassCache) {
      headers['Cache-Control'] = 'no-cache';
      headers.Pragma = 'no-cache';
    }
    const params = init?.bypassCache ? { ...init.params, _ts: String(Date.now()) } : init?.params;
    const response = await this.apiClient.get<T>(path.replace(/^\//, ''), {
      headers,
      params,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: String(response.status), path }, HttpStatus.BAD_GATEWAY);
    }
    return response.data;
  }

  /**
   * Platform Google Maps key from Portal (`GET /api/config/maps`).
   * Returns null when Portal is unreachable, unauthenticated, or the
   * wrangler secret is unset — callers must treat that as best-effort.
   */
  async fetchMapsConfig(): Promise<{ configured: boolean; apiKey?: string } | null> {
    if (!this.publicPortalUrl || !this.configuration.get('ciHubApiKey')) {
      return null;
    }

    try {
      return await this.fetchJson<{ configured: boolean; apiKey?: string }>('/config/maps', {
        authenticated: true,
      });
    } catch {
      return null;
    }
  }

  async fetchStoreListings(params: PortalStoreListingsParams = {}): Promise<unknown> {
    const query: Record<string, string> = {};
    if (params.category) query.category = params.category;
    if (params.tags) query.tags = params.tags;
    if (params.sort) query.sort = params.sort;
    if (params.q) query.q = params.q;
    return this.fetchJson('/store', { params: query, authenticated: true });
  }

  async fetchStoreAlternatives(): Promise<unknown> {
    return this.fetchJson('/store/alternatives');
  }

  async fetchStoreCatalog(init?: { bypassCache?: boolean }): Promise<unknown> {
    return this.fetchJson('/store', { bypassCache: init?.bypassCache, authenticated: true });
  }

  async fetchStoreAppDetails(slug: string): Promise<{ screenshots?: string[]; demo_video?: string } | null> {
    if (!this.publicPortalUrl) {
      return null;
    }

    try {
      return await this.fetchJson<{ screenshots?: string[]; demo_video?: string }>(`/store/${encodeURIComponent(slug)}`);
    } catch {
      return null;
    }
  }

  async fetchAppInstall(slug: string): Promise<unknown> {
    return this.fetchJson(`/store/${encodeURIComponent(slug)}/install`, { authenticated: true });
  }

  /**
   * Hub-facing till check. Returns the HTTP status so callers can tell 402
   * (pay) from 404 (unknown / local app) from a network failure.
   *
   * `null` means Portal is not configured on this Hub — skip the check.
   */
  async checkAppEntitlement(appId: string): Promise<{
    status: number;
    entitled?: boolean;
    reason?: string;
    paymentUrl?: string;
    code?: string;
  } | null> {
    if (!this.outboundPortalUrl) {
      return null;
    }

    const response = await this.apiClient.get<{
      entitled?: boolean;
      reason?: string;
      paymentUrl?: string;
      code?: string;
    }>('entitlements/check', {
      headers: this.getDeviceAuthHeaders(),
      params: { appId },
      validateStatus: () => true,
      timeout: 10_000,
    });

    const data = response.data && typeof response.data === 'object' ? response.data : {};

    return {
      status: response.status,
      entitled: data.entitled,
      reason: data.reason,
      paymentUrl: data.paymentUrl,
      code: data.code,
    };
  }

  /**
   * Hub UX WhoIs. Device key + Portal user `subject`. `organizationId` is
   * not sent — Portal intersects memberships with this appliance.
   *
   * `null` means Portal is not configured; callers apply compiled inherit.
   */
  async whoisApps(params: { subject: string; appIds: string[]; surface: 'hub' | 'store' }): Promise<{
    status: number;
    body: PortalWhoIsResponse | null;
  } | null> {
    if (!this.outboundPortalUrl) {
      return null;
    }

    const response = await this.apiClient.post<PortalWhoIsResponse>(
      'whois',
      {
        subject: params.subject,
        appIds: params.appIds,
        surface: params.surface,
      },
      {
        headers: this.getDeviceAuthHeaders(),
        validateStatus: () => true,
        timeout: 10_000,
      },
    );

    const body = response.data && typeof response.data === 'object' ? response.data : null;

    return { status: response.status, body };
  }

  async fetchStoreMetadataText(appSlug: string, filename: string): Promise<string | null> {
    if (!this.publicPortalUrl) {
      return null;
    }

    try {
      const path = `store/${encodeURIComponent(appSlug)}/metadata/${encodeURIComponent(filename)}`;
      const response = await this.apiClient.get<string>(path, {
        responseType: 'text',
        validateStatus: () => true,
        timeout: 15_000,
      });

      if (response.status < 200 || response.status >= 300) {
        return null;
      }

      if (!this.isAcceptedDescriptionContentType(response.headers['content-type'])) {
        return null;
      }

      const text = typeof response.data === 'string' ? response.data : '';
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  private isAcceptedDescriptionContentType(contentTypeHeader: unknown): boolean {
    const contentType =
      (typeof contentTypeHeader === 'string' ? contentTypeHeader : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : '')
        .split(';')[0]
        ?.trim()
        .toLowerCase() ?? '';

    if (!contentType) {
      return true;
    }

    if (contentType === 'text/markdown' || contentType === 'text/x-markdown' || contentType === 'text/plain') {
      return true;
    }

    if (contentType === 'text/html' || contentType.startsWith('image/')) {
      return false;
    }

    return false;
  }

  async postJson<T = unknown>(path: string, body: unknown, init?: { authenticated?: boolean }): Promise<T> {
    this.requirePortalUrl();
    const headers = {
      'Content-Type': 'application/json',
      ...(init?.authenticated ? this.getDeviceAuthHeaders() : {}),
    };
    const response = await this.apiClient.post<T>(path.replace(/^\//, ''), body, {
      headers,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: String(response.status), path }, HttpStatus.BAD_GATEWAY);
    }
    return response.data;
  }

  async postTunnelState(payload: { organizationId: string; tunnelId: string; apps: unknown[] }): Promise<{
    success?: boolean;
    failed?: string[];
    /** Per-app failure detail; absent on Companion Portal versions that predate it. */
    failures?: PublicDnsFailure[];
    synced?: number;
    /**
     * Custom hostnames Companion Portal actually wired into this device's tunnel ingress
     * on this sync. Absent on Companion Portal versions that predate custom domains —
     * which is NOT the same as an empty array, and the consumer must keep the
     * two apart (see `parseTunnelCustomDomains`).
     */
    customDomains?: TunnelCustomDomain[];
  }> {
    return this.postJson('tunnels/state', payload, { authenticated: true });
  }

  /**
   * A device-authenticated request whose STATUS AND BODY are part of the answer.
   *
   * `fetchJson` / `postJson` collapse every non-2xx into one `PORTAL_REQUEST_FAILED`
   * carrying a status string and nothing else, which is right for the calls whose
   * only question is "did it work". The custom-domain routes are not those: a 404
   * means this Companion Portal predates the feature (a supported deployment, not a
   * fault), a 422 means the domain is still verifying and the caller should try
   * again later, and a 404 on the bind distinguishes "the app has not registered
   * yet" from "that domain is gone" by its `code`. Throwing all of that away and
   * then guessing is how a caller ends up retrying something that can never
   * succeed, or giving up on something that would have worked next minute.
   */
  private async requestWithStatus<T>(method: 'get' | 'post', path: string, body?: unknown): Promise<{ status: number; data: T }> {
    this.requirePortalUrl();
    const url = path.replace(/^\//, '');
    const headers = {
      ...this.getDeviceAuthHeaders(),
      ...(method === 'post' ? { 'Content-Type': 'application/json' } : {}),
    };
    const response =
      method === 'get'
        ? await this.apiClient.get<T>(url, { headers, validateStatus: () => true })
        : await this.apiClient.post<T>(url, body, { headers, validateStatus: () => true });

    return { status: response.status, data: response.data };
  }

  /**
   * The organization's connected custom domains, with the bind state of each.
   *
   * This is not the same thing as `customDomains` on the tunnel-state response. That
   * one is what Companion Portal has wired — the hostnames the tunnel answers for, and
   * the only source an app's public identity may be built from. This is what the
   * organization OWNS: the catalogue an install dialog offers, including domains
   * pointing at nothing and domains not yet proved.
   *
   * 404 on a Companion Portal that predates the route, which the caller reports as
   * "nothing offerable" rather than as an error.
   */
  async fetchDeviceCustomDomains(organizationId?: string): Promise<{ status: number; data: { domains?: unknown } }> {
    /*
     * The organization is VERIFIED by Companion Portal against a `device_registration`
     * row, never believed — so sending it is not a trust boundary, it is a
     * disambiguation. A device CAN be registered to more than one organization
     * (a half-completed cross-org move leaves exactly that), and Companion Portal refuses
     * to guess rather than answering with an arbitrary tenant's domains.
     */
    const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';

    return this.requestWithStatus('get', `/custom-domains/device${query}`);
  }

  /**
   * Ask Companion Portal to point one of those domains at an app on THIS device.
   *
   * The body names the domain's id and the app's SUBDOMAIN — the same string the
   * tunnel-state payload carries — never a hostname: the target is composed on
   * the Companion Portal side from rows it owns, which is the invariant that stops a
   * device pointing a domain into another organization's tunnel. The Hub could
   * not honestly supply one anyway, since it cannot know whether a name really
   * resolves here.
   */
  async postDeviceCustomDomainBind(payload: { domainId: string; appSlug: string; organizationId?: string }): Promise<{
    status: number;
    data: { id?: string; domain?: string; targetHostname?: string; code?: string; error?: string };
  }> {
    return this.requestWithStatus('post', '/custom-domains/device/bind', payload);
  }

  /**
   * Ask CI-Cloud to stop pointing a custom domain at an app on THIS device.
   *
   * ⚠ THIS PARKS THE DOMAIN; IT DOES NOT GIVE IT UP. The route clears
   * `device_id`, `application_id` and `target_hostname` and clears the
   * hostname's origin at the edge, leaving the row, the ownership proof and the
   * certificate intact — the ordinary connect-first/bind-later shape, reached
   * from the other direction. The organization keeps the domain and an ordinary
   * bind points it somewhere else, so the call is idempotent and safe to retry;
   * `unbindCustomDomain` maps `DOMAIN_NOT_FOUND` to success for exactly that
   * reason. Disconnecting a domain is a separate, session-and-managing-role act
   * in the portal that no Hub path reaches.
   *
   * The app slug is REQUIRED and is not decoration: it makes the device assert
   * which of its own apps it believes the domain serves, so a stale intent left
   * by a rename or a reinstall is refused rather than silently taking a
   * different app's domain off the air. The device half of the guard is the
   * authorizing one; an orphaned row whose `application_id` was nulled by an
   * uninstall still parks, or an app could never release a domain it had
   * removed.
   */
  async postDeviceCustomDomainUnbind(payload: { domainId: string; appSlug: string; organizationId?: string }): Promise<{
    status: number;
    data: { success?: boolean; code?: string; error?: string };
  }> {
    return this.requestWithStatus('post', '/custom-domains/device/unbind', payload);
  }

  async postDeviceCheckIn(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson('/devices/check-in', payload, { authenticated: true });
  }

  async postDeviceApplicationsRegistry(payload: {
    organizationId: string;
    apps: Array<{
      name: string;
      slug: string;
      port: number;
      publicDomain?: string;
      remove?: boolean;
    }>;
  }): Promise<{ success?: boolean }> {
    return this.postJson('/devices/applications/registry', payload, { authenticated: true });
  }

  async postDeviceDeregister(deviceId: string): Promise<unknown> {
    return this.postJson('/devices/deregister', { device_id: deviceId }, { authenticated: true });
  }

  /**
   * Verify an Ed25519-signed offline entitlement token with grace period support.
   *
   * Validates:
   * 1. Cryptographic Ed25519 signature against portal public key.
   * 2. App identity matches expectedAppId if provided.
   * 3. Device identity matches expectedDeviceId if provided.
   * 4. Expiration timestamp (exp / expiresAt) against current time.
   *    If expired, verifies whether current time is within grace period.
   */
  verifyOfflineEntitlementToken(
    token: string | { payload: unknown; signature: string },
    options: VerifyOfflineEntitlementOptions = {},
  ): OfflineEntitlementVerificationResult {
    let parsedKey: KeyObject;
    try {
      const configAny = this.configuration.getConfig() as Record<string, unknown>;
      const configuredKey =
        (typeof configAny.ciPortalPublicKey === 'string' ? configAny.ciPortalPublicKey : undefined) ??
        (typeof configAny.portalPublicKey === 'string' ? configAny.portalPublicKey : undefined);

      const keyInput = options.publicKey ?? configuredKey ?? process.env.PORTAL_ED25519_PUBLIC_KEY ?? process.env.CI_PORTAL_PUBLIC_KEY;

      if (!keyInput) {
        return {
          valid: false,
          entitled: false,
          inGracePeriod: false,
          reason: 'missing_public_key',
          error: 'No Ed25519 public key provided or configured',
        };
      }
      parsedKey = parseEd25519PublicKey(keyInput);
    } catch (keyErr) {
      return {
        valid: false,
        entitled: false,
        inGracePeriod: false,
        reason: 'invalid_key',
        error: `Failed to parse public key: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`,
      };
    }

    let parsedToken: { payload: OfflineEntitlementPayload; signedData: Buffer; signature: Buffer; altSignedData?: Buffer };
    try {
      if (typeof token === 'object' && token !== null && 'signature' in token) {
        const rawPayload = (token as { payload: unknown; signature: string }).payload;
        const payloadObj = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as OfflineEntitlementPayload;
        const signedData = Buffer.from(typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload), 'utf8');
        const sigStr = (token as { signature: string }).signature;
        const signature = /^[0-9a-fA-F]{128}$/.test(sigStr) ? Buffer.from(sigStr, 'hex') : decodeBase64OrUrl(sigStr);
        parsedToken = { payload: payloadObj, signedData, signature };
      } else if (typeof token === 'string') {
        const trimmed = token.trim();
        const parts = trimmed.split('.');

        if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
          const payloadJson = decodeBase64OrUrl(parts[1]).toString('utf8');
          const payload = JSON.parse(payloadJson) as OfflineEntitlementPayload;
          const signedData = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
          const signature = decodeBase64OrUrl(parts[2]);
          parsedToken = { payload, signedData, signature };
        } else if (parts.length === 2 && parts[0] && parts[1]) {
          const payloadJson = decodeBase64OrUrl(parts[0]).toString('utf8');
          const payload = JSON.parse(payloadJson) as OfflineEntitlementPayload;
          const signedData = Buffer.from(parts[0], 'utf8');
          const altSignedData = decodeBase64OrUrl(parts[0]);
          const signature = decodeBase64OrUrl(parts[1]);
          parsedToken = { payload, signedData, altSignedData, signature };
        } else {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && 'signature' in parsed) {
            const rawPayload = parsed.payload;
            const payloadObj = (typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload) as OfflineEntitlementPayload;
            const signedData = Buffer.from(typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload), 'utf8');
            const sigStr = parsed.signature;
            const signature = /^[0-9a-fA-F]{128}$/.test(sigStr) ? Buffer.from(sigStr, 'hex') : decodeBase64OrUrl(sigStr);
            parsedToken = { payload: payloadObj, signedData, signature };
          } else {
            throw new Error('Unrecognized token structure');
          }
        }
      } else {
        throw new Error('Invalid token type');
      }
    } catch (parseErr) {
      return {
        valid: false,
        entitled: false,
        inGracePeriod: false,
        reason: 'invalid_token',
        error: `Failed to parse token: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }

    const { payload, signedData, altSignedData, signature } = parsedToken as {
      payload: OfflineEntitlementPayload;
      signedData: Buffer;
      altSignedData?: Buffer;
      signature: Buffer;
    };

    // Cryptographic signature check
    try {
      let verified = crypto.verify(null, signedData, parsedKey, signature);
      if (!verified && altSignedData) {
        verified = crypto.verify(null, altSignedData, parsedKey, signature);
      }
      if (!verified) {
        return {
          valid: false,
          entitled: false,
          inGracePeriod: false,
          reason: 'invalid_signature',
          payload,
          error: 'Ed25519 signature verification failed',
        };
      }
    } catch (verifyErr) {
      return {
        valid: false,
        entitled: false,
        inGracePeriod: false,
        reason: 'invalid_signature',
        payload,
        error: `Signature verification error: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
      };
    }

    // App ID match check
    if (options.expectedAppId) {
      const expected = options.expectedAppId;
      const actual = payload.appId || payload.appUrn;
      if (!actual) {
        return {
          valid: false,
          entitled: false,
          inGracePeriod: false,
          reason: 'app_mismatch',
          payload,
          error: `Token contains no appId, expected ${expected}`,
        };
      }
      const matches = actual === expected || actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
      if (!matches) {
        return {
          valid: false,
          entitled: false,
          inGracePeriod: false,
          reason: 'app_mismatch',
          payload,
          error: `Token appId (${actual}) does not match expected appId (${expected})`,
        };
      }
    }

    // Device ID match check
    if (options.expectedDeviceId && payload.deviceId && payload.deviceId !== options.expectedDeviceId) {
      return {
        valid: false,
        entitled: false,
        inGracePeriod: false,
        reason: 'device_mismatch',
        payload,
        error: `Token deviceId (${payload.deviceId}) does not match expected (${options.expectedDeviceId})`,
      };
    }

    // Expiration and Grace Period check
    const expValue = payload.exp ?? payload.expiresAt;
    if (expValue === undefined || expValue === null) {
      return {
        valid: true,
        entitled: payload.entitled !== false,
        inGracePeriod: false,
        reason: 'valid',
        payload,
      };
    }

    let expMs: number;
    if (typeof expValue === 'number') {
      expMs = expValue < 10_000_000_000 ? expValue * 1000 : expValue;
    } else {
      expMs = Date.parse(String(expValue));
    }

    if (Number.isNaN(expMs)) {
      return {
        valid: false,
        entitled: false,
        inGracePeriod: false,
        reason: 'invalid_token',
        payload,
        error: `Invalid expiration timestamp: ${expValue}`,
      };
    }

    const expiresAt = new Date(expMs);
    const gracePeriodMs =
      options.gracePeriodMs ??
      payload.gracePeriodMs ??
      (payload.gracePeriodSeconds ? payload.gracePeriodSeconds * 1000 : DEFAULT_OFFLINE_ENTITLEMENT_GRACE_MS);
    const graceExpiresAt = new Date(expMs + gracePeriodMs);

    const now = options.currentTime
      ? options.currentTime instanceof Date
        ? options.currentTime.getTime()
        : typeof options.currentTime === 'number'
          ? options.currentTime
          : Date.parse(String(options.currentTime))
      : Date.now();

    if (now <= expMs) {
      return {
        valid: true,
        entitled: payload.entitled !== false,
        inGracePeriod: false,
        reason: 'valid',
        payload,
        expiresAt,
        graceExpiresAt,
      };
    }

    if (now <= expMs + gracePeriodMs) {
      return {
        valid: true,
        entitled: payload.entitled !== false,
        inGracePeriod: true,
        reason: 'grace_period',
        payload,
        expiresAt,
        graceExpiresAt,
      };
    }

    return {
      valid: false,
      entitled: false,
      inGracePeriod: false,
      reason: 'expired',
      payload,
      expiresAt,
      graceExpiresAt,
      error: `Entitlement token expired at ${expiresAt.toISOString()} (grace period ended at ${graceExpiresAt.toISOString()})`,
    };
  }

  createOfflineEntitlementToken(payload: OfflineEntitlementPayload, privateKey: string | KeyObject): string {
    return createOfflineEntitlementToken(payload, privateKey);
  }
}

/**
 * Decode base64 or base64url string to Buffer.
 */
function decodeBase64OrUrl(str: string): Buffer {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) {
    s += '=';
  }
  return Buffer.from(s, 'base64');
}

/**
 * Parses an Ed25519 public key from PEM, JWK, raw 32-byte hex/base64, or KeyObject.
 */
export function parseEd25519PublicKey(keyInput: string | KeyObject): KeyObject {
  if (typeof keyInput !== 'string') {
    return keyInput;
  }
  const trimmed = keyInput.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPublicKey(trimmed);
  }
  if (trimmed.startsWith('{')) {
    try {
      return crypto.createPublicKey({ key: JSON.parse(trimmed), format: 'jwk' });
    } catch {
      // not JWK, fallback
    }
  }
  let rawBuf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    rawBuf = Buffer.from(trimmed, 'hex');
  } else {
    try {
      rawBuf = decodeBase64OrUrl(trimmed);
    } catch {
      return crypto.createPublicKey(trimmed);
    }
  }
  if (rawBuf && rawBuf.length === 32) {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    return crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, rawBuf]), format: 'der', type: 'spki' });
  }
  if (rawBuf && rawBuf.length === 44) {
    return crypto.createPublicKey({ key: rawBuf, format: 'der', type: 'spki' });
  }
  return crypto.createPublicKey(trimmed);
}

/**
 * Parses an Ed25519 private key from PEM, JWK, raw 32-byte hex/base64 seed, or KeyObject.
 */
export function parseEd25519PrivateKey(keyInput: string | KeyObject): KeyObject {
  if (typeof keyInput !== 'string') {
    return keyInput;
  }
  const trimmed = keyInput.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPrivateKey(trimmed);
  }
  if (trimmed.startsWith('{')) {
    try {
      return crypto.createPrivateKey({ key: JSON.parse(trimmed), format: 'jwk' });
    } catch {
      // not JWK, fallback
    }
  }
  let rawBuf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    rawBuf = Buffer.from(trimmed, 'hex');
  } else {
    try {
      rawBuf = decodeBase64OrUrl(trimmed);
    } catch {
      return crypto.createPrivateKey(trimmed);
    }
  }
  if (rawBuf && rawBuf.length === 32) {
    const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    return crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, rawBuf]), format: 'der', type: 'pkcs8' });
  }
  if (rawBuf && rawBuf.length === 48) {
    return crypto.createPrivateKey({ key: rawBuf, format: 'der', type: 'pkcs8' });
  }
  return crypto.createPrivateKey(trimmed);
}

/**
 * Creates and signs an Ed25519 offline entitlement token (JWT/JWS format).
 */
export function createOfflineEntitlementToken(payload: OfflineEntitlementPayload, privateKeyInput: string | KeyObject): string {
  const privateKey = parseEd25519PrivateKey(privateKeyInput);
  const header = { alg: 'EdDSA', typ: 'JWT' };

  const b64url = (data: string | Buffer) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = crypto.sign(null, signedData, privateKey);
  const signatureB64 = b64url(signature);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
