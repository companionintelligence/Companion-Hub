import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { buildSignedForwardAuthHeaders } from '@/modules/auth/utils/forward-auth-signing';

/**
 * Service identity the Hub attests when calling CI-Server's connect endpoints.
 * CI-Server's HubForwardAuthGuard only verifies the HMAC signature (it does not
 * use the username for the exchange/revoke calls), so a stable service label is
 * sufficient and keeps the signed message deterministic.
 */
const HUB_SERVICE_USER = 'ci-hub';

/** Timeout for the server-to-server calls to CI-Server (internal docker network). */
const REQUEST_TIMEOUT_MS = 10_000;

/** The raw key + owning app returned by a successful code exchange. */
export interface MemoryExchangeResult {
  appUrn: string;
  key: string;
}

/**
 * Server-to-server client for CI-Server's connect endpoints, authenticated by
 * the signed Traefik forward-auth headers (`X-CI-Hub-User[/-Timestamp/-Signature]`)
 * keyed on the shared `forwardAuthSecret`. Used to swap a one-time code for the
 * minted memory key, and to revoke an app's key.
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
    const response = await axios.post<MemoryExchangeResult>(
      `${this.trimTrailingSlash(baseUrl)}/api/connect/exchange`,
      { code },
      { headers: this.signedHeaders(), timeout: REQUEST_TIMEOUT_MS },
    );

    return response.data;
  }

  /**
   * Revoke the memory key for an app (agent uninstall / user disconnect /
   * ci-memory reset). Best-effort: logs and swallows transport errors so a
   * revoke never blocks the caller (the key also expires on its own).
   */
  async revoke(baseUrl: string, appUrn: string): Promise<void> {
    try {
      await axios.post(
        `${this.trimTrailingSlash(baseUrl)}/api/connect/revoke`,
        { app: appUrn },
        { headers: this.signedHeaders(), timeout: REQUEST_TIMEOUT_MS },
      );

      this.logger.info(`[MemoryConnect] revoked key for ${appUrn} at ${baseUrl}`);
    } catch (err) {
      this.logger.warn(`[MemoryConnect] revoke request failed for ${appUrn}: ${this.describeError(err)}`);
    }
  }

  /** Build the signed forward-auth headers, throwing if the shared secret is absent. */
  private signedHeaders(): Record<string, string> {
    const secret = this.config.get('forwardAuthSecret');

    if (!secret) {
      throw new Error('Cannot call CI-Server connect endpoints without a forward-auth shared secret');
    }

    return buildSignedForwardAuthHeaders(secret, HUB_SERVICE_USER) as unknown as Record<string, string>;
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
