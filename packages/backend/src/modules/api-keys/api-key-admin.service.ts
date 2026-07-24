import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyInfo, ApiKeyService } from './api-key.service';
import { MCP_SCOPE } from './api-key.scopes';

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
    // Any key may be revoked, including the last one. This used to refuse, to keep the store from
    // ever emptying — because an empty store made the boot-time seed resurrect the derived
    // "Default" key. With no seeding, zero MCP keys is a legitimate state (the tool surface is
    // simply closed) and refusing would instead force an appliance to keep a credential alive that
    // its operator wants gone. Nothing locks the operator out either way: this surface is
    // session-authed, so a replacement can always be created afterwards.
    const revoked = await this.apiKeys.revoke(id);
    this.logger.info('API key admin: key revoke', id, revoked ? 'ok' : 'not-found');
    return { revoked };
  }
}
