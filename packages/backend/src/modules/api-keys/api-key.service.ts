import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { TRANSIENT_DB_RETRY_DELAYS_MS, withTransientDbRetry } from '@/core/database/transient-db-retry';
import { ApiKeyStoreUnavailableError, isTransientDbError } from './api-key.errors';
import { type ApiKeyListRow, type ApiKeyRow, ApiKeyRepository } from './api-key.repository';
import { API_KEY_SCOPES, type ApiKeyScope } from './api-key.scopes';
import { type ApiKeyCapability, DEFAULT_API_KEY_CAPABILITY, coerceApiKeyCapability } from './api-key.capabilities';

const KEY_BYTES = 32; // 64 hex chars — 256 bits of entropy
const PREFIX_LEN = 8; // leading chars shown in the UI to identify a key without revealing it

/**
 * Backoff for transient key-store failures on the auth path (#933). Short and bounded: a client
 * mid-MCP-initialize should ride out a Docker DNS hiccup (`EAI_AGAIN ci-hub-db`), but a genuinely
 * down database must fail fast into a 503, not hold requests hostage.
 */
export const AUTH_LOOKUP_RETRY_DELAYS_MS: readonly number[] = TRANSIENT_DB_RETRY_DELAYS_MS;

/** Operator-facing view of a stored key — never includes the hash or the raw key. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  capability: ApiKeyCapability;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /**
   * The Hub person who created the key, whose grants and role it acts with. `null` for a managed
   * app key, and for one minted by the CLI or before creators were recorded.
   */
  createdByUserId: number | null;
  /** That person's username, where the read joined it (the admin listing); `null` otherwise. */
  createdByUsername: string | null;
}

/**
 * The authenticated identity behind a validated key — what a guard hands downstream so enforcement
 * can consult the *calling key*, not an appliance-wide setting. `name` is carried for logging: an
 * operator reading "denied hub_uninstall_app for 'Laptop CLI' (read)" needs no lookup to act.
 */
export interface ApiKeyContext {
  id: number;
  name: string;
  capability: ApiKeyCapability;
  /**
   * The app a MANAGED key was provisioned to, else `null`. Lets the lifecycle
   * service tell a managed app key's own app, which it may change, from the
   * others, which `capability` decides how far it reaches (CI-Hub#1397).
   */
  ownerAppUrn: string | null;
  /**
   * The Hub person an UNMANAGED key acts as — the one who created it — else `null`: always for a
   * managed key, and for a key nobody is recorded as creating.
   */
  createdByUserId: number | null;
}

function toInfo(row: ApiKeyRow | ApiKeyListRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    capability: coerceApiKeyCapability(row.capability),
    managed: row.managed,
    ownerAppUrn: row.ownerAppUrn,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdByUserId: row.createdByUserId ?? null,
    createdByUsername: 'createdByUsername' in row ? row.createdByUsername : null,
  };
}

/**
 * Normalize a scope set for storage: deduped, stable order. Rejects an empty set rather than
 * storing one — a scopeless key satisfies no surface, so it would be injected into an app's env,
 * look correctly provisioned in the UI, and fail every authentication with nothing to point at.
 */
function normalizeScopes(scopes: ApiKeyScope[]): ApiKeyScope[] {
  // Ordered by API_KEY_SCOPES, not by the order the caller happened to build the array in, so the
  // same grant always persists and renders identically no matter which call site produced it.
  const deduped = new Set(scopes);
  const normalized = API_KEY_SCOPES.filter((scope) => deduped.has(scope));
  if (normalized.length === 0) {
    throw new Error('An API key must carry at least one scope');
  }
  return normalized;
}

/**
 * Hub-wide API-key management (SEC-MCP-8 lineage), modeled on CI-Server's ApiKeyService — a hashed,
 * multi-key store that replaces the single rotatable env secret. Rotation becomes "create new →
 * roll out → revoke old" with no dual-key hack, since many keys are valid at once. Only SHA-256
 * hashes are stored; a raw key is shown exactly once at creation.
 *
 * One key row can carry several scopes ('mcp' tools access, 'app' callback access), so a companion
 * app holds a single credential no matter how many Hub surfaces it consumes, and granting an
 * additional scope updates the row in place without rotating the secret the app already holds.
 * `managed` keys are auto-provisioned for companion apps and revoked on uninstall.
 *
 * Resolution is by hash alone; scope membership is then checked on the resolved row. A key minted
 * for one surface therefore cannot authenticate another, and the surfaces a key opens can change
 * without the key itself changing.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly repo: ApiKeyRepository,
    private readonly logger: LoggerService,
  ) {}

  private hash(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  /**
   * Hash lookup that survives transient infrastructure failures (#933). Retries only errors
   * classified as connectivity trouble (DNS, refused/reset connections, Postgres still starting);
   * anything else — a real query bug — rethrows immediately. When retries are exhausted this
   * throws {@link ApiKeyStoreUnavailableError} so auth surfaces can answer 503 ("could not check
   * your key") instead of 401 ("your key is wrong").
   */
  private async findByHashResilient(hashedKey: string): Promise<ApiKeyRow | undefined> {
    try {
      return await withTransientDbRetry(() => this.repo.findByHash(hashedKey), {
        delaysMs: AUTH_LOOKUP_RETRY_DELAYS_MS,
        onRetry: (err, attempt, maxAttempts) => {
          this.logger.warn(
            `API key lookup hit transient database error (attempt ${attempt}/${maxAttempts})`,
            err instanceof Error ? err.message : String(err),
          );
        },
      });
    } catch (err) {
      // Non-transient query bugs must keep their original type. Exhausted transient
      // failures become ApiKeyStoreUnavailableError so guards can answer 503.
      if (!isTransientDbError(err)) {
        throw err;
      }
      throw new ApiKeyStoreUnavailableError(err);
    }
  }

  /** Fails closed on an unparseable timestamp: `NaN < now` is false, so a naive comparison would
   *  turn a malformed expiry into a key that never expires — the wrong direction for an expiry
   *  check. An expiry we cannot read is treated as reached. */
  private isExpired(key: { expiresAt: string | null }): boolean {
    if (key.expiresAt === null) {
      return false;
    }
    const expiresAtMs = new Date(key.expiresAt).getTime();
    return Number.isNaN(expiresAtMs) || expiresAtMs < Date.now();
  }

  /** Whether a key still grants access (not expired). The single definition of "usable", so any
   *  caller judging a key's state does it with the exact fail-closed rule the auth path uses —
   *  never a second, subtly-different copy. */
  isUsable(key: { expiresAt: string | null }): boolean {
    return !this.isExpired(key);
  }

  /**
   * Create a key. Returns the info PLUS the raw key — the only time the raw value is ever exposed.
   *
   * `createdByUserId` is the Hub person creating it: an unmanaged key acts with that person's grants
   * and role for as long as it lives, so it can never do more than they can. Omitted, nobody is
   * recorded — right for a managed app key, which the Hub provisions.
   */
  async create(
    name: string,
    opts: {
      scopes: ApiKeyScope[];
      capability?: ApiKeyCapability;
      managed?: boolean;
      ownerAppUrn?: string | null;
      createdByUserId?: number | null;
      expiresAt?: string | null;
    },
  ): Promise<ApiKeyInfo & { key: string }> {
    const scopes = normalizeScopes(opts.scopes);
    const capability = opts.capability ?? DEFAULT_API_KEY_CAPABILITY;
    const rawKey = randomBytes(KEY_BYTES).toString('hex');
    const row = await this.repo.insert({
      scopes,
      capability,
      name,
      prefix: rawKey.slice(0, PREFIX_LEN),
      hashedKey: this.hash(rawKey),
      managed: opts.managed ?? false,
      ownerAppUrn: opts.ownerAppUrn ?? null,
      createdByUserId: opts.createdByUserId ?? null,
      expiresAt: opts.expiresAt ?? null,
    });
    this.logger.info(
      'API key created',
      row.id,
      `[${scopes.join(',')}]`,
      capability,
      row.managed ? '(managed)' : '(operator)',
      `createdBy=${row.createdByUserId ?? 'none'}`,
    );
    return { ...toInfo(row), key: rawKey };
  }

  /**
   * Resolve the owning app URN for a raw managed key, or null when the key is absent, expired,
   * not managed (app-owned), or carries none of the accepted scopes. Lets a caller prove
   * "this request came from app X" by presenting X's injected HUB_APP_KEY / HUB_MCP_API_KEY.
   */
  async resolveManagedAppUrn(rawKey: string, acceptedScopes: ApiKeyScope[]): Promise<string | null> {
    if (!rawKey) {
      return null;
    }
    const row = await this.findByHashResilient(this.hash(rawKey));
    if (!row?.managed || this.isExpired(row)) {
      return null;
    }
    if (!acceptedScopes.some((scope) => row.scopes.includes(scope))) {
      return null;
    }
    return row.ownerAppUrn;
  }

  /**
   * Resolve a raw Bearer token to the identity behind it, or null when the key is absent, expired,
   * or does not carry the required scope. Bumps last-used best-effort.
   *
   * The authenticating call: guards use this rather than {@link validate} when downstream code has
   * to consult the *calling key* — which, for the tool surface, is every call. A boolean answer to
   * "is this key valid" is not enough once authority is a property of the credential.
   */
  async resolve(rawKey: string, requiredScope: ApiKeyScope): Promise<ApiKeyContext | null> {
    if (!rawKey) {
      return null;
    }
    const row = await this.findByHashResilient(this.hash(rawKey));
    if (!row || this.isExpired(row) || !row.scopes.includes(requiredScope)) {
      return null;
    }
    // Fire-and-forget: never let a last-used write fail or slow an auth check.
    void this.repo.touchLastUsed(row.id, new Date().toISOString()).catch(() => undefined);
    return {
      id: row.id,
      name: row.name,
      capability: coerceApiKeyCapability(row.capability),
      ownerAppUrn: row.managed ? row.ownerAppUrn : null,
      // A managed key belongs to its app, not to a person, whatever the column holds.
      createdByUserId: row.managed ? null : (row.createdByUserId ?? null),
    };
  }

  /** True if the raw Bearer token matches a stored, non-expired key carrying the required scope.
   *  The yes/no form of {@link resolve}, for surfaces that gate on nothing but validity. */
  async validate(rawKey: string, requiredScope: ApiKeyScope): Promise<boolean> {
    return (await this.resolve(rawKey, requiredScope)) !== null;
  }

  /** All stored keys (every scope), for the hub-wide admin listing — each naming who created it. */
  async list(): Promise<ApiKeyInfo[]> {
    return (await this.repo.list()).map(toInfo);
  }

  /** The managed key an app owns, if any — metadata only, never the hash or raw value. */
  async findManagedByApp(appUrn: string): Promise<ApiKeyInfo | null> {
    const row = await this.repo.findManagedByOwnerAppUrn(appUrn);
    return row ? toInfo(row) : null;
  }

  /** Number of keys carrying a scope (e.g. the MCP settings status count). */
  async count(scope?: ApiKeyScope): Promise<number> {
    return scope ? this.repo.countByScope(scope) : this.repo.countAll();
  }

  /** One key by id — metadata only. Lets a caller read the current capability before changing it,
   *  which is how the admin surface reports what a change actually moved. */
  async findById(id: number): Promise<ApiKeyInfo | null> {
    const row = await this.repo.findById(id);
    return row ? toInfo(row) : null;
  }

  /**
   * Change what a key may do. The secret and the scopes are untouched, so tightening a key that is
   * already deployed does not require re-issuing it — the holder keeps working, with less authority.
   * Returns false when the id no longer exists (e.g. revoked in another tab).
   */
  async setCapability(id: number, capability: ApiKeyCapability): Promise<boolean> {
    const changed = (await this.repo.updateCapability(id, capability)) > 0;
    if (changed) {
      this.logger.info('API key capability changed', id, capability);
    }
    return changed;
  }

  async revoke(id: number): Promise<boolean> {
    const removed = await this.repo.deleteById(id);
    if (removed > 0) {
      this.logger.info('API key revoked', id);
    }
    return removed > 0;
  }

  /**
   * Provision a companion app's managed key with exactly the given scopes. If the app's existing
   * key still validates as its own managed key, it is preserved (mirrors how HUB_WAKE_SECRET is
   * preserved across reinstalls) and only its scope set is reconciled in place — a scope change
   * must never rotate a credential the running app already holds. Otherwise any stale managed
   * key for the app is revoked and a fresh one is minted. Returns the raw key to inject.
   *
   * Capability is deliberately NOT reconciled here. An operator who tightened an app's key meant it,
   * and re-provisioning runs on every env regeneration — resetting capability would quietly undo the
   * decision on the app's next restart, which is exactly when nobody is looking. Only a fresh key
   * (there was none to preserve) starts at the default.
   */
  async provisionManagedKey(params: { appUrn: string; appName: string; existingRawKey?: string; scopes: ApiKeyScope[] }): Promise<string> {
    const { appUrn, appName, existingRawKey } = params;
    const scopes = normalizeScopes(params.scopes);
    if (existingRawKey) {
      const row = await this.repo.findByHash(this.hash(existingRawKey));
      if (row?.managed && row.ownerAppUrn === appUrn && !this.isExpired(row)) {
        const current = row.scopes;
        if (current.length !== scopes.length || !scopes.every((scope) => current.includes(scope))) {
          await this.repo.updateScopes(row.id, scopes);
          this.logger.info('Managed key scopes updated', appUrn, `[${scopes.join(',')}]`);
        }
        return existingRawKey; // still valid — preserve it (no churn, no restart needed)
      }
    }
    await this.repo.deleteByOwnerAppUrn(appUrn); // clear any stale managed key(s) for this app
    const created = await this.create(appName, { scopes, managed: true, ownerAppUrn: appUrn });
    this.logger.info('Managed key provisioned', appUrn, `[${scopes.join(',')}]`);
    return created.key;
  }

  /**
   * Revoke a companion app's managed key(s). Called on uninstall (access dies with the app) and on
   * an operator rotate (the old key stops resolving before the app restarts holding a fresh one),
   * so the log line names neither — an operator reading it during a rotate should not be told the
   * app was uninstalled.
   */
  async revokeManagedByApp(appUrn: string): Promise<void> {
    const removed = await this.repo.deleteByOwnerAppUrn(appUrn);
    if (removed > 0) {
      this.logger.info('Managed key revoked', appUrn, `(${removed})`);
    }
  }
}
