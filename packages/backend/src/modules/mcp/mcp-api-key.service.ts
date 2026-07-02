import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type McpApiKeyRow, McpApiKeyRepository } from './mcp-api-key.repository';

const KEY_BYTES = 32; // 64 hex chars — 256 bits of entropy
const PREFIX_LEN = 8; // leading chars shown in the UI to identify a key without revealing it

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

function toInfo(row: McpApiKeyRow): McpApiKeyInfo {
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
    private readonly repo: McpApiKeyRepository,
    private readonly logger: LoggerService,
  ) {}

  private hash(rawKey: string): string {
    return createHash('sha256').update(rawKey).digest('hex');
  }

  private isExpired(row: McpApiKeyRow): boolean {
    return row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now();
  }

  /** Create a key. Returns the info PLUS the raw key — the only time the raw value is ever exposed. */
  async create(
    name: string,
    opts: { managed?: boolean; ownerAppUrn?: string | null; expiresAt?: string | null } = {},
  ): Promise<McpApiKeyInfo & { key: string }> {
    const rawKey = randomBytes(KEY_BYTES).toString('hex');
    const row = await this.repo.insert({
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
    const row = await this.repo.findByHash(this.hash(rawKey));
    if (!row || this.isExpired(row)) {
      return false;
    }
    // Fire-and-forget: never let a last-used write fail or slow an auth check.
    void this.repo.touchLastUsed(row.id, new Date().toISOString()).catch(() => undefined);
    return true;
  }

  async list(): Promise<McpApiKeyInfo[]> {
    return (await this.repo.list()).map(toInfo);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  async revoke(id: number): Promise<boolean> {
    const removed = await this.repo.deleteById(id);
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
      const row = await this.repo.findByHash(this.hash(existingRawKey));
      if (row?.managed && row.ownerAppUrn === appUrn && !this.isExpired(row)) {
        return existingRawKey; // still valid — preserve it (no churn, no restart needed)
      }
    }
    await this.repo.deleteByOwnerAppUrn(appUrn); // clear any stale managed key(s) for this app
    const created = await this.create(appName, { managed: true, ownerAppUrn: appUrn });
    this.logger.info('MCP managed key provisioned', appUrn);
    return created.key;
  }

  /** Revoke a companion app's managed key(s) — called on uninstall so access dies with the app. */
  async revokeManagedByApp(appUrn: string): Promise<void> {
    const removed = await this.repo.deleteByOwnerAppUrn(appUrn);
    if (removed > 0) {
      this.logger.info('MCP managed key revoked on uninstall', appUrn, `(${removed})`);
    }
  }

  /**
   * One-time migration: if the store is empty but a legacy `MCP_API_KEY` exists (env/settings.json),
   * seed it as an operator key so upgraded appliances keep working and the key shows in the UI. The
   * auth guard also accepts the env key as a break-glass fallback, so this is non-critical.
   */
  async seedLegacyKeyIfEmpty(): Promise<void> {
    const legacy = process.env.MCP_API_KEY;
    if (!legacy || (await this.repo.count()) > 0) {
      return;
    }
    await this.repo.insert({
      name: 'Default (migrated)',
      prefix: legacy.slice(0, PREFIX_LEN),
      hashedKey: this.hash(legacy),
      managed: false,
      ownerAppUrn: null,
      expiresAt: null,
    });
    this.logger.info('MCP: seeded legacy MCP_API_KEY as an operator key');
  }
}
