import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { buildSignedConnectHeaders } from '@/modules/auth/utils/connect-request-signing';

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
 * + path + body hash + nonce + timestamp) keyed on the dedicated forward-auth
 * shared secret. Used to swap a one-time code for the minted memory key, to
 * revoke an app's key, and to rotate it before expiry.
 */
@Injectable()
export class MemoryExchangeClient {
  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Exchange a one-time connect code for the raw memory key. `baseUrl` is
   * CI-Server's internal address on the shared docker network.
   *
   * @throws if the shared secret is unset or CI-Server rejects/does not answer.
   */
  async exchange(baseUrl: string, code: string): Promise<MemoryExchangeResult> {
    return this.post<MemoryExchangeResult>(baseUrl, '/connect/exchange', { code });
  }

  /**
   * Rotate the app's memory key before expiry; returns the new raw key.
   *
   * @throws if the shared secret is unset or CI-Server rejects/does not answer.
   */
  async rotate(baseUrl: string, appUrn: string): Promise<MemoryExchangeResult> {
    return this.post<MemoryExchangeResult>(baseUrl, '/connect/rotate', { app: appUrn });
  }

  /**
   * Whether a stored memory key still authenticates against ci-memory. Used for
   * lazy staleness detection: a `401` means the key was invalidated (e.g.
   * ci-memory was reset) and should be cleared so the app re-prompts. Any other
   * outcome (2xx, or a transient network/5xx error) is treated as "still valid"
   * so a blip never drops a working connection.
   */
  async isKeyValid(baseUrl: string, token: string): Promise<boolean> {
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
  async revoke(baseUrl: string, appUrn: string): Promise<boolean> {
    try {
      await this.post(baseUrl, '/connect/revoke', { app: appUrn });
      this.logger.info(`[MemoryConnect] revoked key for ${appUrn} at ${baseUrl}`);

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
  private async post<T>(baseUrl: string, apiPath: string, body: Record<string, unknown>): Promise<T> {
    const secret = this.config.get('forwardAuthSecret');

    if (!secret) {
      throw new Error('Cannot call CI-Server connect endpoints without a forward-auth shared secret');
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
