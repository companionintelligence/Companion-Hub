import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { buildSignedConnectHeaders } from '@/modules/auth/utils/connect-request-signing';
import { EnvUtils } from '@/modules/env/env.utils';
import { memoryConnectSecret } from './memory-connect-secret';

/** The Companion Memory a connect call goes to: its gateway on its own network, and its install. */
export interface MemoryConnectTarget {
  internalUrl: string | null;
  appUrn: AppUrn;
}

/** Timeout for the server-to-server calls to CI-Server (internal docker network). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * CI-Server sits behind an nginx gateway that strips the `/api` prefix before
 * forwarding to the API (`rewrite ^/api/(.*)$ /$1 break`), and the API declares
 * no global route prefix. So the URL we POST to must carry `/api` for the
 * gateway to route it, but the path the API actually receives — and therefore
 * the path its ConnectRequestAuthGuard verifies the signature against — is
 * WITHOUT `/api`. We must sign the server-relative path (`/connect/...`), not
 * the gateway URL path, or every signature mismatches and the guard 401s.
 *
 * Exported because the same fact governs the URL handed to consumer apps that treat
 * the brokered address as an API base (see `memoryUrlForStyle`): if the gateway's mount
 * point ever moves, one constant must move with it — otherwise the Hub's own calls get
 * fixed while every consumer keeps posting into the SPA.
 */
export const GATEWAY_API_PREFIX = '/api';

/** The raw key + owning app returned by a successful code exchange or rotation. */
export interface MemoryExchangeResult {
  appUrn: string;
  key: string;
  /** ISO-8601 instant the key expires; the rotation sweep refreshes it before this. */
  expiresAt: string;
}

/**
 * Server-to-server client for CI-Server's connect endpoints. Each request is
 * signed with a replay-resistant signature (see connect-request-signing: method
 * + path + body hash + nonce + timestamp) keyed on that Memory's own connect key
 * (`memoryConnectSecret`), never the Hub-wide secret. Used to swap a one-time code for the minted memory key, to
 * revoke an app's key, and to rotate it before expiry.
 */
@Injectable()
export class MemoryExchangeClient {
  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Exchange a one-time connect code for the raw memory key. `baseUrl` is
   * CI-Server's gateway address on its own network (`ResolvedMemoryProvider.internalUrl`),
   * null while it is not running.
   *
   * @throws if the shared secret is unset or CI-Server rejects/does not answer.
   */
  async exchange(provider: MemoryConnectTarget, code: string): Promise<MemoryExchangeResult> {
    return this.post<MemoryExchangeResult>(provider, '/connect/exchange', { code });
  }

  /**
   * Rotate the app's memory key before expiry; returns the new raw key.
   *
   * @throws if the shared secret is unset or CI-Server rejects/does not answer.
   */
  async rotate(provider: MemoryConnectTarget, appUrn: string): Promise<MemoryExchangeResult> {
    return this.post<MemoryExchangeResult>(provider, '/connect/rotate', { app: appUrn });
  }

  /**
   * Whether a stored memory key still authenticates against ci-memory. Used for
   * lazy staleness detection: a `401` means the key was invalidated (e.g.
   * ci-memory was reset) and should be cleared so the app re-prompts. Any other
   * outcome (2xx, or a transient network/5xx error) is treated as "still valid"
   * so a blip never drops a working connection.
   */
  async isKeyValid(baseUrl: string | null, token: string): Promise<boolean> {
    if (!baseUrl) {
      // ci-memory's gateway is not running: nothing to ask, and a stopped gateway is not a revoked key.
      return true;
    }
    try {
      await axios.get(`${this.trimTrailingSlash(baseUrl)}/api/memory/context`, {
        headers: { 'x-api-key': token },
        timeout: REQUEST_TIMEOUT_MS,
        // Never follow a redirect: axios does not strip the x-api-key header on a
        // cross-origin 3xx, so a redirect could leak the memory key. The S2S target
        // is a trusted internal endpoint that answers JSON/4xx, never a redirect.
        maxRedirects: 0,
      });

      return true;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        return false;
      }

      return true;
    }
  }

  /**
   * Revoke the memory key for an app (agent uninstall / user disconnect /
   * ci-memory reset). Returns true ONLY when CI-Server confirmed the revocation;
   * on any transport/rejection it logs and returns false (never throws) so the
   * caller decides whether that is fatal — `disconnect` keeps the connection so
   * the UI never falsely shows "disconnected" while the key is still live, while
   * uninstall proceeds regardless (the key then lapses on its own TTL).
   */
  async revoke(provider: MemoryConnectTarget, appUrn: string): Promise<boolean> {
    try {
      await this.post(provider, '/connect/revoke', { app: appUrn });
      this.logger.info(`[MemoryConnect] revoked key for ${appUrn} at ${provider.internalUrl}`);

      return true;
    } catch (err) {
      this.logger.warn(`[MemoryConnect] revoke request failed for ${appUrn}: ${this.describeError(err)}`);

      return false;
    }
  }

  /**
   * POST a signed request to a connect endpoint and return its JSON body.
   *
   * @param apiPath the server-relative path CI-Server sees (no `/api` prefix,
   *   e.g. `/connect/exchange`). This is the path that gets SIGNED, because the
   *   gateway strips `/api` before the guard reconstructs the path it verifies.
   *   The request is still POSTed to the `/api`-prefixed URL so nginx routes it.
   */
  private async post<T>(provider: MemoryConnectTarget, apiPath: string, body: Record<string, unknown>): Promise<T> {
    const baseUrl = provider.internalUrl;
    if (!baseUrl) {
      throw new Error("Companion Memory's gateway is not running");
    }
    // That Memory's own key, never the Hub-wide secret (see memory-connect-secret.ts).
    const secret = await memoryConnectSecret(
      this.moduleRef.get(AppFilesManager, { strict: false }),
      this.moduleRef.get(EnvUtils, { strict: false }),
      this.config.get('forwardAuthSecret'),
      provider.appUrn,
    );

    if (!secret) {
      throw new Error(`Companion Memory ${provider.appUrn} has no connect key of its own yet; restart it so the Hub writes one`);
    }

    const headers = buildSignedConnectHeaders(secret, 'POST', apiPath, body) as unknown as Record<string, string>;
    const url = `${this.trimTrailingSlash(baseUrl)}${GATEWAY_API_PREFIX}${apiPath}`;
    const response = await axios.post<T>(url, body, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      // Never follow a redirect: axios does not strip the signed connect headers
      // (X-CI-Connect-Signature, derived from the forward-auth secret) on a
      // cross-origin 3xx, so a redirect could leak them. Connect endpoints answer
      // JSON/4xx, never a redirect.
      maxRedirects: 0,
    });

    return response.data;
  }

  private trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private describeError(err: unknown): string {
    if (axios.isAxiosError(err)) {
      return `${err.response?.status ?? 'no-status'} ${err.message}`;
    }

    return err instanceof Error ? err.message : String(err);
  }
}
