import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import { GATEWAY_API_PREFIX } from '@/modules/memory-connect/memory-exchange.client';
import { MemoryProviderResolver } from '@/modules/memory-connect/memory-provider.resolver';

/**
 * `valid` / `invalid` are Memory's answer. `unknown` means it could not be asked or did not say
 * (unreachable, timed out, a 5xx, or a Memory too old to have the check route).
 */
export type MemoryKeyVerdict = 'valid' | 'invalid' | 'unknown';

/** How long Memory's "valid" is reused. A key revoked in Memory stops passing the edge within this. */
const VALID_TTL_MS = 60_000;
/** How long "invalid" is reused, so a client retrying a dead key does not cost Memory a check each time. */
const INVALID_TTL_MS = 30_000;
/** Bound on remembered verdicts, so a stream of made-up keys cannot grow the map without end. */
const MAX_ENTRIES = 1_000;
/** The check is a hash lookup on Memory's side; anything slower is Memory in trouble. */
const REQUEST_TIMEOUT_MS = 3_000;
/** How long the provider's internal address is reused before it is looked up again. */
const PROVIDER_TTL_MS = 60_000;

/**
 * Asks Companion Memory whether an API key is one it would accept, for Traefik forward-auth.
 *
 * Memory's API keys are Memory's: the Hub cannot read them, so before this it let any request to
 * Memory carrying a non-empty `x-api-key` through and left the key to Memory. Now it asks Memory
 * first (`GET <internal>/api/keys/check`, server to server on the shared docker network) and
 * refuses a key Memory says it does not know, so made-up keys stop at the edge.
 *
 * Verdicts are kept in memory, keyed by a SHA-256 of the key -- the raw key is never stored --
 * and requests for the same key while one is in flight share its answer. `unknown` is never
 * remembered: a Memory restarting must not turn into a minute of refusals.
 */
@Injectable()
export class MemoryApiKeyCheck {
  private readonly verdicts = new Map<string, { valid: boolean; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<MemoryKeyVerdict>>();
  private provider: { url: string; expiresAt: number } | null = null;

  constructor(
    private readonly providers: MemoryProviderResolver,
    private readonly logger: LoggerService,
  ) {}

  async check(rawKey: string): Promise<MemoryKeyVerdict> {
    const id = createHash('sha256').update(rawKey).digest('hex');
    const remembered = this.verdicts.get(id);

    if (remembered) {
      if (remembered.expiresAt > Date.now()) {
        return remembered.valid ? 'valid' : 'invalid';
      }
      this.verdicts.delete(id);
    }

    const pending = this.inFlight.get(id);
    if (pending) {
      return pending;
    }

    const asking = this.ask(rawKey)
      .then((verdict) => {
        if (verdict !== 'unknown') {
          this.remember(id, verdict === 'valid');
        }
        return verdict;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, asking);
    return asking;
  }

  /** Drops every remembered verdict (a factory reset, or tests). */
  clear(): void {
    this.verdicts.clear();
    this.provider = null;
  }

  private async ask(rawKey: string): Promise<MemoryKeyVerdict> {
    const base = await this.providerUrl();
    if (!base) {
      return 'unknown';
    }
    try {
      const response = await axios.get(`${base}${GATEWAY_API_PREFIX}/keys/check`, {
        headers: { 'x-api-key': rawKey },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (response.status === 204 || response.status === 200) {
        return 'valid';
      }
      if (response.status === 401 || response.status === 403) {
        return 'invalid';
      }
      // A 404 is a Memory from before the check route; anything else, Memory having a bad moment.
      this.logger.debug(`[MemoryApiKeyCheck] key check answered ${response.status}; letting Memory decide`);
      return 'unknown';
    } catch (error) {
      this.logger.debug(`[MemoryApiKeyCheck] key check failed: ${error instanceof Error ? error.message : String(error)}`);
      this.provider = null;
      return 'unknown';
    }
  }

  private async providerUrl(): Promise<string | null> {
    if (this.provider && this.provider.expiresAt > Date.now()) {
      return this.provider.url;
    }
    try {
      const found = await this.providers.findProvider();
      if (!found) {
        return null;
      }
      this.provider = { url: found.internalUrl.replace(/\/+$/, ''), expiresAt: Date.now() + PROVIDER_TTL_MS };
      return this.provider.url;
    } catch {
      return null;
    }
  }

  private remember(id: string, valid: boolean): void {
    const now = Date.now();
    if (this.verdicts.size >= MAX_ENTRIES && !this.verdicts.has(id)) {
      for (const [key, entry] of this.verdicts) {
        if (entry.expiresAt <= now) {
          this.verdicts.delete(key);
        }
      }
      if (this.verdicts.size >= MAX_ENTRIES) {
        const oldest = this.verdicts.keys().next().value;
        if (oldest !== undefined) {
          this.verdicts.delete(oldest);
        }
      }
    }
    this.verdicts.set(id, { valid, expiresAt: now + (valid ? VALID_TTL_MS : INVALID_TTL_MS) });
  }
}
