import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { type ApiKeyInfo, ApiKeyService } from './api-key.service';
import { type OperatorMintableScope } from './api-key.scopes';
import type { ApiKeyCapability } from './api-key.capabilities';

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
   * `scope` is which surface the key opens, and is limited to `OPERATOR_MINTABLE_SCOPES` — see that
   * constant for why 'app' and 'qa:read' are not on it. It defaults to 'mcp' in the DTO, which is
   * what this method minted before the parameter existed.
   *
   * `capability` is what the key may do on the MCP tool surface, and there it IS a choice: a key
   * minted for a third-party MCP client to read memory has no business installing apps. On an
   * 'inference' key it is inert — running a completion is neither a read nor a write of appliance
   * state — so it is stored as given and never consulted. Stored rather than forced to a fixed
   * value because a scope that later grows a meaningful capability should not have to unpick a
   * column full of a placeholder.
   *
   * `createdByUserId` is the person creating it. The key acts with that person's grants and role
   * from then on, so it can never do more than they can; `null` is a caller with no person behind it
   * (the CLI), and such a key has no creator, like one minted before creators were recorded.
   * Required, not defaulted: a key with no creator keeps its per-app reach on every app, so a caller
   * that forgot to say who is creating one must not get that by omission.
   */
  async createKey(
    name: string,
    capability: ApiKeyCapability,
    createdByUserId: number | null,
    scope: OperatorMintableScope = 'mcp',
  ): Promise<ApiKeyInfo & { key: string }> {
    const created = await this.apiKeys.create(name, { scopes: [scope], capability, createdByUserId });
    this.logger.info('API key admin: key created', created.id, scope, capability, `createdBy=${createdByUserId ?? 'none'}`);
    return created;
  }

  /**
   * Change an existing key's capability. Reports the level it moved from as well as to, so the audit
   * line and the UI both describe a transition rather than just a new state — "write → full" is the
   * fact an operator reviewing the log needs, and `changed: false` alone cannot tell "no such key"
   * from "already at that level".
   *
   * Managed (app-owned) keys are eligible too. An operator who decides Hermes should be read-only on
   * their appliance is entitled to that, and re-provisioning preserves the choice
   * ({@link ApiKeyService.provisionManagedKey}) — the UI is where the consequence gets explained.
   */
  async setKeyCapability(
    id: number,
    capability: ApiKeyCapability,
  ): Promise<{ changed: boolean; capability: ApiKeyCapability; previousCapability: ApiKeyCapability | null }> {
    const existing = await this.apiKeys.findById(id);
    if (!existing) {
      this.logger.info('API key admin: capability change', id, 'not-found');
      return { changed: false, capability, previousCapability: null };
    }
    if (existing.capability === capability) {
      return { changed: false, capability, previousCapability: existing.capability };
    }
    const changed = await this.apiKeys.setCapability(id, capability);
    this.logger.info('API key admin: capability change', id, `${existing.capability} -> ${capability}`, changed ? 'ok' : 'not-found');
    return { changed, capability, previousCapability: existing.capability };
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
