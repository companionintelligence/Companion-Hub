import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppUrn } from '@ci-hub/common/types';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppFilesManager } from '../apps/app-files-manager';
import { AuthGuard } from '../auth/auth.guard';
import {
  FORWARD_AUTH_SIGNATURE_HEADER,
  FORWARD_AUTH_TIMESTAMP_HEADER,
  FORWARD_AUTH_USER_HEADER,
  verifyForwardAuthHeaders,
} from '../auth/utils/forward-auth-signing';
import { InternalNetworkGuard } from '../auth/internal-network.guard';
import { FORWARD_AUTH_SECRET_ENV } from '../auth/forward-auth-secret.resolver';
import { EnvUtils } from '../env/env.utils';
import { UserRepository } from '../user/user.repository';
import { ManagedAppKeyGuard } from './managed-app-key.guard';
import { MemoryConnectService, MemoryConsentUnreachableException } from './memory-connect.service';

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
 * Browser routes are session-guarded (the user is signed into the Hub). `start`, `callback`
 * and `disconnect` restart the app, so they also take its `restart` grant. The
 * wrapper-facing state/skip routes are authorized by {@link ManagedAppKeyGuard}
 * (the app presents its own managed key, bound to its URN) — that is the real
 * boundary. {@link InternalNetworkGuard} is layered on as best-effort defense in
 * depth only; it is NOT an internal-network guarantee, since these routes are
 * reachable through the public tunnel and `req.ip` reflects the proxy unless
 * `HUB_TRUST_PROXY` is configured (see main.ts).
 */
/** The Hub page that carries on a Connect Memory navigation with the page's own session token. */
export const MEMORY_CONNECT_PAGE_PATH = '/memory-connect/continue';

/** The Hub page for one step, with the navigation's own parameters (relative: same origin as the request). */
function memoryConnectPageUrl(step: 'start' | 'callback', params: Record<string, string | undefined>): string {
  const query = new URLSearchParams({ step });
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) {
      query.set(key, value);
    }
  }

  return `${MEMORY_CONNECT_PAGE_PATH}?${query.toString()}`;
}

@Controller('memory-connect')
export class MemoryConnectController {
  constructor(
    private readonly service: MemoryConnectService,
    private readonly logger: LoggerService,
    private readonly users: UserRepository,
    private readonly appFiles: AppFilesManager,
    private readonly envUtils: EnvUtils,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  /**
   * The link an app's launcher and the Hub UI open. It decides nothing: it hands the navigation to the
   * Hub page at {@link MEMORY_CONNECT_PAGE_PATH}, which asks `POST /start` with the page's session token.
   *
   * ⚠ A NAVIGATION CARRIES NO HEADER, AND THE HUB'S COOKIE IS NO CREDENTIAL (`auth/session-token.ts`).
   * These routes used to act on the `ci-hub-sid` the navigation brought along, and that cookie goes to
   * every port on the Hub's host, where any app could replay it.
   */
  @Get('start')
  startNavigation(@Query('app') app: string | undefined, @Query('next') next: string | undefined, @Res() res: Response): void {
    res.redirect(memoryConnectPageUrl('start', { app, next }));
  }

  /** Where ci-memory's consent returns. Handed to the Hub page like {@link startNavigation}. */
  @Get('callback')
  callbackNavigation(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): void {
    res.redirect(memoryConnectPageUrl('callback', { code, state, error }));
  }

  /** Asked by the Hub page with its session token: answers where the browser goes next (`{ url }`). */
  @UseGuards(AuthGuard)
  @Post('start')
  async start(@Body() body: { app?: unknown; next?: unknown }, @Req() req: Request): Promise<{ url: string }> {
    const app = typeof body?.app === 'string' && body.app ? body.app : undefined;
    const next = typeof body?.next === 'string' && body.next ? body.next : undefined;

    if (!app) {
      throw new BadRequestException('app is required');
    }

    // Connecting restarts the app, so it takes the grant the restart route asks for. Refused like
    // the route's other refusals: the browser lands on the Hub with a marker, never on a raw 403.
    if (!(await this.mayRestart(req, this.parseAppUrn(app)))) {
      this.logger.warn(`[MemoryConnect] connect refused for ${app}: no restart grant`);

      return { url: '/?memoryConnect=denied' };
    }

    // `next` is validated server-side in startConnect (origin-allowlisted against
    // the Hub + the connecting app), so an attacker can't use it as an open redirect.
    // Bind the flow to the initiating user so the callback must be the same user.
    // The request origin keeps the whole ceremony on the origin the user arrived
    // on — a LAN user must not be relocated to the public origin mid-flow, where
    // their Hub session does not exist.
    try {
      return { url: await this.service.startConnect(app as AppUrn, next, this.currentUserId(req), this.requestOrigin(req)) };
    } catch (err) {
      // A connect that can't start (ci-memory not installed / not reachable yet /
      // no Hub origin) lands the user back on the Hub with a marker. The readiness gating
      // normally keeps the launcher link hidden until ci-memory is running, so this only covers
      // the race where it goes down between the status poll and the click.
      // A consent page this browser can't open says so, rather than "not ready yet".
      if (err instanceof MemoryConsentUnreachableException) {
        this.logger.warn(`[MemoryConnect] connect could not start for ${app}: ${err.message}`);

        return { url: err.hubComputerOnly ? '/?memoryConnect=hub_computer_only' : '/?memoryConnect=local_only' };
      }

      if (err instanceof BadRequestException) {
        this.logger.warn(`[MemoryConnect] connect could not start for ${app}: ${err.message}`);

        return { url: '/?memoryConnect=unavailable' };
      }

      throw err;
    }
  }

  /** Asked by the Hub page with its session token once consent returns: answers where to go next. */
  @UseGuards(AuthGuard)
  @Post('callback')
  async callback(@Body() body: { code?: unknown; state?: unknown; error?: unknown }, @Req() req: Request): Promise<{ url: string }> {
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const code = text(body?.code);
    const state = text(body?.state);
    const error = text(body?.error);

    // The user denied consent on ci-memory (or an upstream error). Nothing was
    // minted; return them to the app they started from (where the interstitial
    // re-appears) rather than dead-ending on the Hub dashboard.
    //
    // `error` is CI-Server's own code — `login_required`, `server_error`, or (from
    // CI-Server#1742) `csrf_failed` when the consent form's token could not be
    // recovered on a second attempt. It is logged rather than swallowed: the gate
    // simply reappearing with no trace is exactly the fail-silent behaviour
    // CI-Engineering#75 set out to remove.
    if (error || !code || !state) {
      this.logger.warn(`[MemoryConnect] callback without a usable code (error=${error ?? 'none'})`);

      return { url: this.service.abandonConnect(state, this.currentUserId(req), error) };
    }

    try {
      // On success `next` is the SPA's finishing interstitial (the restart is
      // scheduled, not awaited — this handler must answer the browser fast); on a
      // downstream failure it is the app's page in the Hub, which says the connect
      // failed: the app's own address could not (#2544). A replayed state (refresh after an
      // aborted navigation) resolves to the interstitial too, without a second
      // exchange. The current user must match the one who started the flow
      // (login-CSRF guard).
      // The grant `/start` checked is asked again, since this is what restarts the app.
      const { next } = await this.service.handleCallback(code, state, this.currentUserId(req), (appUrn) => this.mayRestart(req, appUrn));

      return { url: next };
    } catch (err) {
      // An unknown or expired state (no app to return to), or a connect that threw after the state
      // was consumed. The service records that one's failure, so a refresh lands on the app's page.
      this.logger.error('[MemoryConnect] callback failed', err);

      return { url: '/?memoryConnect=error' };
    }
  }

  /**
   * Wrapper-facing state. `clientHost` is the `Host` the WRAPPER itself was
   * reached on, forwarded by the app because this request is server-to-server:
   * it arrives over the internal docker network, so `req.headers.host` here is
   * `ci-hub:5002` and says nothing about where the user's browser is. Without
   * it the Hub could never tell a LAN visitor from a remote one, and would never
   * offer the LAN launcher to the callers that need it most.
   *
   * Untrusted but harmless: the caller is already authenticated by
   * {@link ManagedAppKeyGuard}, and the only thing this influences is whether the
   * response carries the Hub's own LAN address — which an installed app already
   * holds as `HUB_URL`.
   */
  @UseGuards(InternalNetworkGuard, ManagedAppKeyGuard)
  @Get('apps/:urn/state')
  async state(@Param('urn') urn: string, @Query('clientHost') clientHost: string | string[] | undefined, @Req() req: Request) {
    // A repeated `?clientHost=` surfaces as string[] under Express, so collapse to
    // the first entry: `host` is a single origin, and letting an array through
    // would smuggle a non-string into RequestOriginContext.host.
    const host = Array.isArray(clientHost) ? clientHost[0] : clientHost;
    const origin = host ? { host } : this.requestOrigin(req);

    const appUrn = this.decodeUrn(urn);
    const hubUserId = await this.resolveForwardedHubUserId(req, appUrn);

    return this.service.getStatus(appUrn, origin, hubUserId);
  }

  @UseGuards(AuthGuard)
  @Get('apps/:urn/status')
  async status(@Param('urn') urn: string, @Req() req: Request) {
    return this.service.getUiStatus(this.decodeUrn(urn), this.requestOrigin(req), this.currentUserId(req));
  }

  @UseGuards(AuthGuard)
  @Get('consumers')
  async consumers() {
    return { consumers: await this.service.listConnectedConsumers() };
  }

  @UseGuards(InternalNetworkGuard, ManagedAppKeyGuard)
  @Post('apps/:urn/skip')
  async skip(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = this.decodeUrn(urn);
    await this.service.skip(appUrn, await this.resolveForwardedHubUserId(req, appUrn));

    return { ok: true };
  }

  @UseGuards(AuthGuard)
  @Post('apps/:urn/disconnect')
  async disconnect(@Param('urn') urn: string, @Req() req: Request, @Body() _body: unknown) {
    const appUrn = this.decodeUrn(urn);
    // Disconnecting restarts the app too. Who may disconnect whose connection is decided after this.
    await this.whois.assertSessionAction(req, this.parseAppUrn(appUrn), 'restart');
    await this.service.disconnect(appUrn, this.currentUserId(req));

    return { ok: true };
  }

  /** A malformed id is the caller's mistake (400), not a server error. */
  private parseAppUrn(raw: string): AppUrn {
    try {
      return castAppUrn(raw);
    } catch {
      throw new BadRequestException('app is not a valid app id');
    }
  }

  /** Whether this person holds the app's `restart` grant. Only a refusal is false; anything else throws. */
  private async mayRestart(req: Request, appUrn: AppUrn): Promise<boolean> {
    try {
      await this.whois.assertSessionAction(req, appUrn, 'restart');

      return true;
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.FORBIDDEN) {
        return false;
      }

      throw err;
    }
  }

  /**
   * The authenticated Hub user's id as a string. Only called after
   * `AuthGuard` has admitted the request, so the
   * flow's `state` can be bound to (and re-verified against) this user.
   */
  private currentUserId(req: Request): string {
    const id = (req as Request & { user?: { id?: number | string } }).user?.id;

    return String(id ?? '');
  }

  /**
   * The wrapper forwards Traefik's signed Hub identity so we can tell which
   * person opened the app (the S2S call itself is the app's managed key).
   */
  private async resolveForwardedHubUserId(req: Request, appUrn: AppUrn): Promise<string | null> {
    const header = (name: string): string | null => {
      const raw = req.headers[name.toLowerCase()];
      if (Array.isArray(raw)) {
        return raw[0] ?? null;
      }

      return raw ?? null;
    };

    // The app's own key only. Forward auth signs nothing with the Hub-wide secret for an app
    // without one, so a header set that verifies under it was not sent by forward auth.
    let secret = '';
    try {
      const appEnv = await this.appFiles.getAppEnv(appUrn);
      secret = (this.envUtils.envStringToMap(appEnv.content).get(FORWARD_AUTH_SECRET_ENV) ?? '').trim();
    } catch {
      secret = '';
    }

    const verified = verifyForwardAuthHeaders(secret, {
      user: header(FORWARD_AUTH_USER_HEADER),
      timestamp: header(FORWARD_AUTH_TIMESTAMP_HEADER),
      signature: header(FORWARD_AUTH_SIGNATURE_HEADER),
    });

    if (!verified.ok) {
      return null;
    }

    const user = await this.users.getUserByUsername(verified.username);

    return user ? String(user.id) : null;
  }

  /**
   * Where this request reached the Hub, so the service can answer "can THIS
   * caller connect?" and keep the ceremony on one origin.
   *
   * Correct for the browser-facing routes (`/start`, `/status`), where the
   * request really is the user's browser. The wrapper-facing `/state` route does
   * NOT use this — see its own docstring.
   */
  private requestOrigin(req: Request): { host?: string } {
    return { host: req.headers.host };
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
