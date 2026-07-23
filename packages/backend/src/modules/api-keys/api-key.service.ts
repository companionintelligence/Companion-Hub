import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyRow, ApiKeyRepository } from './api-key.repository';
import { type ApiKeyScope, MCP_SCOPE } from './api-key.scopes';

const KEY_BYTES = 32; // 64 hex chars — 256 bits of entropy
const PREFIX_LEN = 8; // leading chars shown in the UI to identify a key without revealing it

/** Operator-facing view of a stored key — never includes the hash or the raw key. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function toInfo(row: ApiKeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    managed: row.managed,
    ownerAppUrn: row.ownerAppUrn,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/** Normalize a scope set for storage: deduped, stable order. Never empty at the call sites. */
function normalizeScopes(scopes: ApiKeyScope[]): ApiKeyScope[] {
  return [...new Set(scopes)];
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

  private isExpired(row: ApiKeyRow): boolean {
    return row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now();
  }

  /** Create a key. Returns the info PLUS the raw key — the only time the raw value is ever exposed. */
  async create(
    name: string,
    opts: { scopes: ApiKeyScope[]; managed?: boolean; ownerAppUrn?: string | null; expiresAt?: string | null },
  ): Promise<ApiKeyInfo & { key: string }> {
    const scopes = normalizeScopes(opts.scopes);
    const rawKey = randomBytes(KEY_BYTES).toString('hex');
    const row = await this.repo.insert({
      audience: scopes[0] ?? MCP_SCOPE, // transitional dual-write; see ApiKeyRepository
      scopes,
      name,
      prefix: rawKey.slice(0, PREFIX_LEN),
      hashedKey: this.hash(rawKey),
      managed: opts.managed ?? false,
      ownerAppUrn: opts.ownerAppUrn ?? null,
      expiresAt: opts.expiresAt ?? null,
    });
    this.logger.info('API key created', row.id, `[${scopes.join(',')}]`, row.managed ? '(managed)' : '(operator)');
    return { ...toInfo(row), key: rawKey };
  }

  /** A row's effective scopes. Legacy rows written before the scopes column may have an empty
   *  array if the backfill has not run (or was rolled past); fall back to the audience column so a
   *  pre-migration key never silently loses access. */
  private effectiveScopes(row: ApiKeyRow): string[] {
    return row.scopes.length > 0 ? row.scopes : [row.audience];
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
    const row = await this.repo.findByHash(this.hash(rawKey));
    if (!row?.managed || this.isExpired(row)) {
      return null;
    }
    const scopes = this.effectiveScopes(row);
    if (!acceptedScopes.some((scope) => scopes.includes(scope))) {
      return null;
    }
    return row.ownerAppUrn;
  }

  /** True if the raw Bearer token matches a stored, non-expired key carrying the required scope.
   *  Bumps last-used best-effort. */
  async validate(rawKey: string, requiredScope: ApiKeyScope): Promise<boolean> {
    if (!rawKey) {
      return false;
    }
    const row = await this.repo.findByHash(this.hash(rawKey));
    if (!row || this.isExpired(row) || !this.effectiveScopes(row).includes(requiredScope)) {
      return false;
    }
    // Fire-and-forget: never let a last-used write fail or slow an auth check.
    void this.repo.touchLastUsed(row.id, new Date().toISOString()).catch(() => undefined);
    return true;
  }

  /** All stored keys (every scope), for the hub-wide admin listing. */
  async list(): Promise<ApiKeyInfo[]> {
    return (await this.repo.list()).map(toInfo);
  }

  /** Number of keys carrying a scope (e.g. the MCP settings status count). */
  async count(scope?: ApiKeyScope): Promise<number> {
    return scope ? this.repo.countByScope(scope) : this.repo.countAll();
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
   */
  async provisionManagedKey(params: { appUrn: string; appName: string; existingRawKey?: string; scopes: ApiKeyScope[] }): Promise<string> {
    const { appUrn, appName, existingRawKey } = params;
    const scopes = normalizeScopes(params.scopes);
    if (existingRawKey) {
      const row = await this.repo.findByHash(this.hash(existingRawKey));
      if (row?.managed && row.ownerAppUrn === appUrn && !this.isExpired(row)) {
        const current = this.effectiveScopes(row);
        if (current.length !== scopes.length || !scopes.every((scope) => current.includes(scope))) {
          await this.repo.updateScopes(row.id, scopes, scopes[0] ?? row.audience);
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

  /** Revoke a companion app's managed key(s) — called on uninstall so access dies with the app. */
  async revokeManagedByApp(appUrn: string): Promise<void> {
    const removed = await this.repo.deleteByOwnerAppUrn(appUrn);
    if (removed > 0) {
      this.logger.info('Managed key revoked on uninstall', appUrn, `(${removed})`);
    }
  }

  /**
   * Ensure the appliance has at least one usable MCP-scoped key. When the store is empty, seed the
   * derived `MCP_API_KEY` (env-helpers always provides one) as the revocable "Default" operator
   * key. This is how the store — now the sole auth authority (the guard no longer accepts the env
   * key directly) — stays in sync with the value pre-upgrade agents already hold, and how a wiped
   * DB self-heals on the next boot. It is NOT gated on "migrated": a fresh appliance's key is
   * equally the default.
   *
   * Seeding is empty-store-only, so it never resurrects a specific key an operator deliberately
   * revoked while other keys remain. To retire the Default key, create a replacement first
   * (leaving the store non-empty) and then revoke Default — it will not be reseeded. The admin
   * surface enforces this by refusing to revoke the last remaining operator key; an empty store
   * can only arise from external interference (wipe/restore), where re-seeding is the desired
   * self-heal.
   */
  async seedDefaultKeyIfEmpty(): Promise<void> {
    const envKey = process.env.MCP_API_KEY;
    if (!envKey || (await this.repo.countByScope(MCP_SCOPE)) > 0) {
      return;
    }
    // Conflict-tolerant so a double-start race (two boots seeding the same derived key) is a no-op
    // for the loser instead of a unique-index violation that kills its bootstrap.
    const seeded = await this.repo.insertIfHashAbsent({
      audience: MCP_SCOPE,
      scopes: [MCP_SCOPE],
      name: 'Default',
      prefix: envKey.slice(0, PREFIX_LEN),
      hashedKey: this.hash(envKey),
      managed: false,
      ownerAppUrn: null,
      expiresAt: null,
    });
    if (seeded) {
      this.logger.info('Seeded the default MCP key from MCP_API_KEY');
    }
  }
}
