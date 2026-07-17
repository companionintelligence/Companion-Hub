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
 *   GET  /api/memory-connect/callback         → browser: return from ci-memory, apply, redirect to the
 *                                               SPA's /memory-connect/finishing interstitial (which
 *                                               watches the restart and forwards to `next`)
 *   GET  /api/memory-connect/apps/:urn/state  → wrapper: {state, connectUrl}
 *   GET  /api/memory-connect/consumers        → browser: {consumers} still connected to the provider
 *   POST /api/memory-connect/apps/:urn/skip   → wrapper: mark skipped
 *   POST /api/memory-connect/apps/:urn/disconnect → browser: revoke + clear + restart
 *
 * Browser routes are session-guarded (the user is signed into the Hub). The
 * wrapper-facing state/skip routes are authorized by {@link ManagedAppKeyGuard}
 * (the app presents its own managed key, bound to its URN) — that is the real
 * boundary. {@link InternalNetworkGuard} is layered on as best-effort defense in
 * depth only; it is NOT an internal-network guarantee, since these routes are
 * reachable through the public tunnel and `req.ip` reflects the proxy unless
 * `HUB_TRUST_PROXY` is configured (see main.ts).
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
    // Bind the flow to the initiating user so the callback must be the same user.
    try {
      const consentUrl = await this.service.startConnect(app as AppUrn, next, this.currentUserId(req));
      res.redirect(consentUrl);
    } catch (err) {
      // A connect that can't start (ci-memory not installed / not reachable yet /
      // no Hub origin) must not dump a raw 400 JSON body into a top-level browser
      // navigation. The readiness gating normally keeps the launcher link hidden
      // until ci-memory is running, so this only covers the race where it goes down
      // between the status poll and the click — land the user back on the Hub with
      // an error marker (mirrors the callback's ?memoryConnect=error handling).
      if (err instanceof BadRequestException) {
        this.logger.warn(`[MemoryConnect] connect could not start for ${app}: ${err.message}`);
        res.redirect('/?memoryConnect=unavailable');

        return;
      }

      throw err;
    }
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
      res.redirect(this.service.abandonConnect(state, this.currentUserId(req)));

      return;
    }

    try {
      // On success `next` is the SPA's finishing interstitial (the restart is
      // scheduled, not awaited — this handler must answer the browser fast); on a
      // downstream failure it is the app URL, so the user always lands back on
      // their app rather than the dashboard. A replayed state (refresh after an
      // aborted navigation) resolves to the interstitial too, without a second
      // exchange. The current user must match the one who started the flow
      // (login-CSRF guard).
      const { next } = await this.service.handleCallback(code, state, this.currentUserId(req));
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

  @UseGuards(AuthGuard)
  @Get('consumers')
  async consumers() {
    return { consumers: await this.service.listConnectedConsumers() };
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
   * The authenticated Hub user's id as a string. Only called after
   * {@link redirectIfUnauthenticated} has confirmed `req.user` is present, so the
   * flow's `state` can be bound to (and re-verified against) this user.
   */
  private currentUserId(req: Request): string {
    const id = (req as Request & { user?: { id?: number | string } }).user?.id;

    return String(id ?? '');
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
