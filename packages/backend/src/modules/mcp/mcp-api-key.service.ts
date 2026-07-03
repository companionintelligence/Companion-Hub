import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyRow, ApiKeyRepository } from './api-key.repository';

const KEY_BYTES = 32; // 64 hex chars — 256 bits of entropy
const PREFIX_LEN = 8; // leading chars shown in the UI to identify a key without revealing it
// This service owns the 'mcp' slice of the shared api_key table; a future REST-key service would use
// its own audience against the same repository.
const MCP_AUDIENCE = 'mcp';

/** Operator-facing view of a stored key — never includes the hash or the raw key. */
export interface McpApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  managed: boolean;
  ownerAppUrn: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function toInfo(row: ApiKeyRow): McpApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    managed: row.managed,
    ownerAppUrn: row.ownerAppUrn,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/**
 * SEC-MCP-8: MCP API-key management, modeled on CI-Server's ApiKeyService — a hashed, multi-key store
 * that replaces the single rotatable env secret. Rotation becomes "create new → roll out → revoke
 * old" with no dual-key hack, since many keys are valid at once. Only SHA-256 hashes are stored; a
 * raw key is shown exactly once at creation. `managed` keys are auto-provisioned for companion apps.
 */
@Injectable()
export class McpApiKeyService {
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
    opts: { managed?: boolean; ownerAppUrn?: string | null; expiresAt?: string | null } = {},
  ): Promise<McpApiKeyInfo & { key: string }> {
    const rawKey = randomBytes(KEY_BYTES).toString('hex');
    const row = await this.repo.insert({
      audience: MCP_AUDIENCE,
      name,
      prefix: rawKey.slice(0, PREFIX_LEN),
      hashedKey: this.hash(rawKey),
      managed: opts.managed ?? false,
      ownerAppUrn: opts.ownerAppUrn ?? null,
      expiresAt: opts.expiresAt ?? null,
    });
    this.logger.info('MCP API key created', row.id, row.managed ? '(managed)' : '(operator)');
    return { ...toInfo(row), key: rawKey };
  }

  /** True if the raw Bearer token matches a stored, non-expired key. Bumps last-used best-effort. */
  async validate(rawKey: string): Promise<boolean> {
    if (!rawKey) {
      return false;
    }
    const row = await this.repo.findByHash(this.hash(rawKey), MCP_AUDIENCE);
    if (!row || this.isExpired(row)) {
      return false;
    }
    // Fire-and-forget: never let a last-used write fail or slow an auth check.
    void this.repo.touchLastUsed(row.id, new Date().toISOString()).catch(() => undefined);
    return true;
  }

  async list(): Promise<McpApiKeyInfo[]> {
    return (await this.repo.listByAudience(MCP_AUDIENCE)).map(toInfo);
  }

  async count(): Promise<number> {
    return this.repo.countByAudience(MCP_AUDIENCE);
  }

  async revoke(id: number): Promise<boolean> {
    const removed = await this.repo.deleteById(id, MCP_AUDIENCE); // scoped so MCP can't revoke another surface's key
    if (removed > 0) {
      this.logger.info('MCP API key revoked', id);
    }
    return removed > 0;
  }

  /**
   * Provision a companion app's managed key. If the app's existing key still validates as its own
   * managed key, preserve it (mirrors how HUB_WAKE_SECRET is preserved across reinstalls); otherwise
   * revoke any stale managed key for the app and mint a fresh one. Returns the raw key to inject.
   */
  async provisionManagedKey(params: { appUrn: string; appName: string; existingRawKey?: string }): Promise<string> {
    const { appUrn, appName, existingRawKey } = params;
    if (existingRawKey) {
      const row = await this.repo.findByHash(this.hash(existingRawKey), MCP_AUDIENCE);
      if (row?.managed && row.ownerAppUrn === appUrn && !this.isExpired(row)) {
        return existingRawKey; // still valid — preserve it (no churn, no restart needed)
      }
    }
    await this.repo.deleteByOwnerAppUrn(appUrn, MCP_AUDIENCE); // clear any stale MCP managed key(s) for this app
    const created = await this.create(appName, { managed: true, ownerAppUrn: appUrn });
    this.logger.info('MCP managed key provisioned', appUrn);
    return created.key;
  }

  /** Revoke a companion app's managed key(s) — called on uninstall so access dies with the app. */
  async revokeManagedByApp(appUrn: string): Promise<void> {
    const removed = await this.repo.deleteByOwnerAppUrn(appUrn, MCP_AUDIENCE);
    if (removed > 0) {
      this.logger.info('MCP managed key revoked on uninstall', appUrn, `(${removed})`);
    }
  }

  /**
   * Ensure the appliance has at least one usable MCP key. When the store is empty, seed the derived
   * `MCP_API_KEY` (env-helpers always provides one) as the revocable "Default" operator key. This is
   * how the store — now the sole auth authority (the guard no longer accepts the env key directly) —
   * stays in sync with the value pre-upgrade agents already hold, and how a wiped DB self-heals on
   * the next boot. It is NOT gated on "migrated": a fresh appliance's key is equally the default.
   *
   * Seeding is empty-store-only, so it never resurrects a specific key an operator deliberately
   * revoked while other keys remain. To retire the Default key, create a replacement first (leaving
   * the store non-empty) and then revoke Default — it will not be reseeded. The admin surface
   * enforces this by refusing to revoke the last remaining key (see McpAdminService.revokeKey);
   * an empty store can only arise from external interference (wipe/restore), where re-seeding is
   * the desired self-heal.
   */
  async seedDefaultKeyIfEmpty(): Promise<void> {
    const envKey = process.env.MCP_API_KEY;
    if (!envKey || (await this.repo.countByAudience(MCP_AUDIENCE)) > 0) {
      return;
    }
    // Conflict-tolerant so a double-start race (two boots seeding the same derived key) is a no-op
    // for the loser instead of a unique-index violation that kills its bootstrap.
    const seeded = await this.repo.insertIfHashAbsent({
      audience: MCP_AUDIENCE,
      name: 'Default',
      prefix: envKey.slice(0, PREFIX_LEN),
      hashedKey: this.hash(envKey),
      managed: false,
      ownerAppUrn: null,
      expiresAt: null,
    });
    if (seeded) {
      this.logger.info('MCP: seeded the default MCP key from MCP_API_KEY');
    }
  }
}
