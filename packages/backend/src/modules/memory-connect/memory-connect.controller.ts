import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { InternalNetworkGuard } from '../auth/internal-network.guard';
import { ManagedAppKeyGuard } from './managed-app-key.guard';
import { MemoryConnectService } from './memory-connect.service';

/**
 * Endpoints backing the memory-connect flow.
 *
 *   GET  /api/memory-connect/start            → browser: begin connect (→ ci-memory consent)
 *   GET  /api/memory-connect/callback         → browser: return from ci-memory, apply, redirect to `next`
 *   GET  /api/memory-connect/apps/:urn/state  → wrapper: {state, connectUrl} (internal network)
 *   POST /api/memory-connect/apps/:urn/skip   → wrapper: mark skipped (internal network)
 *   POST /api/memory-connect/apps/:urn/disconnect → browser: revoke + clear + restart
 *
 * Browser routes are session-guarded (the user is signed into the Hub); the
 * wrapper-facing state/skip routes are reachable only from the internal docker
 * network (the app wrapper calls the Hub at CI_HUB_URL).
 */
@Controller('memory-connect')
export class MemoryConnectController {
  constructor(
    private readonly service: MemoryConnectService,
    private readonly logger: LoggerService,
  ) {}

  @Get('start')
  async start(
    @Query('app') app: string | undefined,
    @Query('next') next: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // These are top-level browser navigations, so an unauthenticated session
    // must bounce to the login page — not receive a raw 401 JSON body.
    if (this.redirectIfUnauthenticated(req, res)) {
      return;
    }

    if (!app) {
      throw new BadRequestException('app is required');
    }

    // `next` is validated server-side in startConnect (origin-allowlisted against
    // the Hub + the connecting app), so an attacker can't use it as an open redirect.
    const consentUrl = await this.service.startConnect(app as AppUrn, next);
    res.redirect(consentUrl);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (this.redirectIfUnauthenticated(req, res)) {
      return;
    }

    // The user denied consent on ci-memory (or an upstream error). Nothing was
    // minted; return them to the app they started from (where the interstitial
    // re-appears) rather than dead-ending on the Hub dashboard.
    if (error || !code || !state) {
      this.logger.warn(`[MemoryConnect] callback without a usable code (error=${error ?? 'none'})`);
      res.redirect(this.service.abandonConnect(state));

      return;
    }

    try {
      // handleCallback returns the app URL even on a downstream failure, so the
      // user always lands back on their app rather than the dashboard.
      const { next } = await this.service.handleCallback(code, state);
      res.redirect(next);
    } catch (err) {
      // Only an unknown/expired state reaches here (no app to return to).
      this.logger.error('[MemoryConnect] callback failed', err);
      res.redirect('/?memoryConnect=error');
    }
  }

  @UseGuards(InternalNetworkGuard, ManagedAppKeyGuard)
  @Get('apps/:urn/state')
  async state(@Param('urn') urn: string) {
    return this.service.getStatus(this.decodeUrn(urn));
  }

  @UseGuards(AuthGuard)
  @Get('apps/:urn/status')
  async status(@Param('urn') urn: string) {
    return this.service.getUiStatus(this.decodeUrn(urn));
  }

  @UseGuards(InternalNetworkGuard, ManagedAppKeyGuard)
  @Post('apps/:urn/skip')
  async skip(@Param('urn') urn: string) {
    await this.service.skip(this.decodeUrn(urn));

    return { ok: true };
  }

  @UseGuards(AuthGuard)
  @Post('apps/:urn/disconnect')
  async disconnect(@Param('urn') urn: string, @Req() _req: Request, @Body() _body: unknown) {
    await this.service.disconnect(this.decodeUrn(urn));

    return { ok: true };
  }

  /**
   * For the browser-facing GET routes: if there is no authenticated Hub session,
   * redirect to the login page and return true (handled). The session is
   * populated by the auth middleware the same way AuthGuard consumes it; unlike
   * AuthGuard (which 401s with JSON), a top-level navigation must land on a page.
   */
  private redirectIfUnauthenticated(req: Request, res: Response): boolean {
    if ((req as Request & { user?: unknown }).user) {
      return false;
    }

    this.logger.warn('[MemoryConnect] unauthenticated browser navigation → redirecting to /login');
    res.redirect('/login');

    return true;
  }

  /**
   * URNs contain a colon and may arrive percent-encoded. Express has already
   * URL-decoded the route param, so this is normally a no-op; decode defensively
   * inside try/catch so a malformed `%` sequence yields a clean 4xx (no match)
   * rather than an unhandled URIError → 500.
   */
  private decodeUrn(urn: string): AppUrn {
    try {
      return decodeURIComponent(urn) as AppUrn;
    } catch {
      return urn as AppUrn;
    }
  }
}
