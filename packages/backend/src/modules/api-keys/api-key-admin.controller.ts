import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { TranslatableError } from '@/common/error/translatable-error';
import { LoggerService } from '@/core/logger/logger.service';
import { hubSessionOperatorUserId } from '@/core/portal/hub-session-operator';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ApiKeyAdminService } from './api-key-admin.service';
import { CreateApiKeyBody, UpdateApiKeyBody } from './api-key-admin.dto';

/**
 * Operator-facing hub-wide API-key surface, powering the Settings → Security "API keys" card.
 * Session-authed ({@link AuthGuard}) so the browser never handles agent keys; raw key values are
 * returned exactly once at creation and never listed. The MCP settings screen links here — key
 * management is hub-wide, not an MCP-subsystem concern.
 */
@Controller('api-keys')
@UseGuards(AuthGuard)
export class ApiKeyAdminController {
  constructor(
    private readonly adminService: ApiKeyAdminService,
    private readonly moduleRef: ModuleRef,
    private readonly logger: LoggerService,
  ) {}

  /** List all stored API keys (operator + app-managed, every scope). Never returns raw keys. */
  @Get()
  async listKeys() {
    return { keys: await this.adminService.listKeys() };
  }

  /**
   * Whether the caller may give a key full capability, so the screen offers that choice only to
   * someone who can make it. The create and change routes decide regardless.
   *
   * Its own route rather than a field on the list: answering it asks the Portal, and the list is a
   * database read that must not wait on a slow or unreachable Portal, nor ask it again after every
   * create, change and revoke.
   */
  @Get('grantable')
  async grantableCapabilities(@Req() req: Request) {
    return { canGrantFull: await this.mayGrantFull(req) };
  }

  /**
   * Create an operator API key. Returns the raw key ONCE so it can be copied; only the hash is stored.
   *
   * The key is recorded as the signed-in person's, and acts with their grants and role from then on
   * (`LifecycleActor`). A principal with no person behind it — the CLI — records nobody, which is
   * where every key minted before creators were recorded stands too. A `full` key also takes an
   * organization owner or admin; see {@link mayGrantFull}.
   */
  @Post()
  async createKey(@Body() body: CreateApiKeyBody, @Req() req: Request) {
    if (body.capability === 'full') {
      await this.assertMayGrantFull(req);
    }

    return this.adminService.createKey(body.name, body.capability, hubSessionOperatorUserId(req) ?? null);
  }

  /**
   * Change what an existing key may do (read → write → full, or back). The secret is untouched, so a
   * key already deployed to an agent can be tightened or widened without re-issuing it.
   *
   * PATCH rather than PUT: this replaces one property of the key, not the key. Session-authed like the
   * rest of this controller; the confirmation the UI shows before a promotion is UX, not the security
   * boundary. Raising a key to `full` takes an organization owner or admin ({@link mayGrantFull});
   * tightening one takes nobody's permission.
   */
  @Patch(':id')
  async updateKey(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateApiKeyBody, @Req() req: Request) {
    if (body.capability === 'full') {
      await this.assertMayGrantFull(req);
    }

    return this.adminService.setKeyCapability(id, body.capability);
  }

  /** Revoke a key by id (create-new → roll-out → revoke-old is the no-downtime rotation flow). */
  @Delete(':id')
  revokeKey(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.revokeKey(id);
  }

  /**
   * ⚠ FULL CAPABILITY IS THE ORGANIZATION'S TO GIVE. A key acts with its creator's grants, but `full`
   * also opens the destructive MCP tools, and some act on no app a per-app grant could bound: updating
   * the Hub, and adding, re-enabling or deleting an app store. So who may hand it out is an owner's or
   * admin's call, as it is in the Portal. Asked of WhoIs fresh and about no app (`isOrgManager`); every
   * way of not knowing is a no.
   *
   * The exempt principals (the CLI, the Portal device push) are admitted by name, as
   * `MarketplaceWhoIsService.lifecycleActor` names them, not through `isGrantExemptPrincipal`: one
   * added to that list later is refused here until someone decides it may hand out `full` keys. Any
   * other principal is refused and logged the way the other gates log it, because all its caller
   * ever sees is a 403.
   */
  private async mayGrantFull(req: Request): Promise<boolean> {
    switch (req.hubPrincipal) {
      case 'cli':
      case 'portal-device':
        return true;
      case 'session': {
        const userId = hubSessionOperatorUserId(req);

        return userId !== undefined && (await this.resolveWhois()?.isOrgManager(userId)) === true;
      }
      default:
        this.logger.warn(`whois_unrecognised_principal principal=${req.hubPrincipal ?? 'none'} action=grant_full`);
        return false;
    }
  }

  private async assertMayGrantFull(req: Request): Promise<void> {
    if (!(await this.mayGrantFull(req))) {
      throw new TranslatableError('API_KEY_FULL_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
    }
  }

  /**
   * Resolved when asked, the way the lifecycle service resolves it, so the key module keeps depending
   * on nothing but the database and the logger. `null` — cannot resolve — is a refusal, never a pass.
   */
  private resolveWhois(): MarketplaceWhoIsService | null {
    try {
      return this.moduleRef.get(MarketplaceWhoIsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}
