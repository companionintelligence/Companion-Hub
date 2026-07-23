import { ConflictException, Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyInfo, ApiKeyService } from './api-key.service';
import { MCP_SCOPE } from './api-key.scopes';

/** A key still counts as access: not expired (expiresAt null = never expires). */
function isUsable(key: ApiKeyInfo): boolean {
  return key.expiresAt === null || new Date(key.expiresAt).getTime() > Date.now();
}

/**
 * Business logic behind the session-authed hub-wide API-key admin surface (moved out of the MCP
 * admin service when keys grew beyond the MCP scope). Lists every stored key — operator and
 * app-managed, all scopes — and owns create/revoke for operator keys. Managed keys are created
 * only by app provisioning, never here.
 */
@Injectable()
export class ApiKeyAdminService {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly logger: LoggerService,
  ) {}

  /** List all stored API keys (operator + managed, every scope) — hashes/raw values never included. */
  async listKeys(): Promise<ApiKeyInfo[]> {
    return this.apiKeys.list();
  }

  /**
   * SEC-MCP-8: create an operator API key. Returns the raw key exactly once so the operator can copy
   * it; only its hash is stored. Multiple keys are valid at once, so "rotation" is create-new →
   * roll-out → revoke-old, with no downtime for connected agents.
   *
   * Operator keys carry the 'mcp' scope only: the 'app' scope requires an owning app URN to satisfy
   * the callback guard's identity check, so an operator-created 'app' key could never authenticate
   * anything — offering it would only mint dead credentials.
   */
  async createKey(name: string): Promise<ApiKeyInfo & { key: string }> {
    const created = await this.apiKeys.create(name, { scopes: [MCP_SCOPE] });
    this.logger.info('API key admin: key created', created.id);
    return created;
  }

  /** Revoke a key by id. Managed keys can be revoked too (break-glass) — the owning app loses Hub
   *  access until it is re-provisioned on its next install/env-regen. */
  async revokeKey(id: number): Promise<{ revoked: boolean }> {
    const keys = await this.apiKeys.list();
    const target = keys.find((k) => k.id === id);
    if (!target) {
      this.logger.info('API key admin: key revoke', id, 'not-found');
      return { revoked: false };
    }
    // SEC-MCP-8: never revoke the last USABLE OPERATOR key. Managed keys don't count (uninstalls
    // delete them, and an operator must not lose access when the last app leaves) and neither do
    // expired keys. This guarantees the store never empties through any path, so the boot-time
    // seed can never resurrect a deliberately revoked Default key. Revoking an already-unusable
    // (expired) key is always allowed — deleting a dead key can't reduce access. (Two concurrent
    // revokes could race past this check; a single operator drives this UI, so we accept that
    // over a transactional delete.)
    if (!target.managed && isUsable(target)) {
      const usableOperatorKeys = keys.filter((k) => !k.managed && isUsable(k));
      if (usableOperatorKeys.length <= 1) {
        throw new ConflictException('Cannot revoke the last operator API key — create a replacement key first');
      }
    }
    const revoked = await this.apiKeys.revoke(id);
    this.logger.info('API key admin: key revoke', id, revoked ? 'ok' : 'not-found');
    return { revoked };
  }
}
