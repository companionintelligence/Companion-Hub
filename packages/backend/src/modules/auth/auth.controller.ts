import crypto from 'node:crypto';
import net from 'node:net';
import { SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_NAME } from '@/common/constants';
import { buildHubPublicOrigin } from '@/common/helpers/hub-origin';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { buildSignedForwardAuthHeaders } from './utils/forward-auth-signing';
import { normalizeForwardedHost, rawForwardedHost } from './utils/forward-auth-host';
import { ForwardAuthSecretResolver } from './forward-auth-secret.resolver';
import { UserRepository } from '@/modules/user/user.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { SessionManager } from './session.manager';
import {
  BrowserHandoffMintBody,
  BrowserHandoffMintDto,
  ChangePasswordBody,
  ChangeUsernameBody,
  CheckResetPasswordRequestDto,
  DisableTotpBody,
  GetTotpUriBody,
  GetTotpUriDto,
  LoginBody,
  LoginDto,
  PasswordResetCompleteBody,
  PasswordResetCompleteDto,
  PasswordResetRequestBody,
  PasswordResetRequestDto,
  PasswordResetVerifyResponseDto,
  PortalDesktopExchangeDto,
  PortalSessionHintDto,
  RegisterBody,
  RegisterDto,
  ResetPasswordBody,
  ResetPasswordDto,
  SessionRefreshDto,
  SetupTotpBody,
  VerifyTotpBody,
} from './dto/auth.dto';
import { ApiResponse } from '@nestjs/swagger';
import {
  buildPortalDesktopDeepLink,
  buildPortalSsoErrorRedirectUrl,
  exchangePortalAuthorizationCode,
  fetchPortalSessionEmail,
  type PortalDesktopExchange,
  type PortalSsoErrorCode,
  type PortalSsoState,
  resolveHubRequestOrigin,
  resolvePortalCallbackUrl,
  resolveRequestOriginFallback,
  resolveSameOriginRedirectUrl,
  resolveTrustedReturnOrigin,
  toDesktopRedirectPath,
} from './portal-sso';

/** Query param carrying the single-use edge-SSO ticket between the Hub and an app host (#77). */
const EDGE_SSO_TICKET_PARAM = 'cihub_sso';
const EDGE_SSO_CACHE_PREFIX = 'edge_sso:';
const EDGE_SSO_COUNTER_PREFIX = 'edge_sso_mints:';
/** Mints allowed per (session, app host) per minute before the loop guard breaks the redirect
 *  cycle a cookie-refusing browser would otherwise ride forever. */
const EDGE_SSO_MAX_MINTS_PER_MINUTE = 3;
/** Width of the loop-guard window, in seconds. Fixed, not sliding — see the mint counter below. */
const EDGE_SSO_MINT_WINDOW_SECONDS = 60;
/** Ticket lifetime, in seconds. The browser consumes it within one redirect hop, so this only has
 *  to cover that round trip — a longer window just widens the replay surface. */
const EDGE_SSO_TICKET_TTL_SECONDS = 60;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly forwardAuthSecrets: ForwardAuthSecretResolver,
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly cache: CacheService,
    private readonly userRepository: UserRepository,
    private readonly sessionManager: SessionManager,
    private readonly registrationService: RegistrationService,
    private readonly deviceRegistration: DeviceRegistrationRepository,
  ) {}

  /**
   * `scope` overrides the host/proto the cookie is scoped to. The edge-SSO consume needs it: that
   * request arrives with the tunnel-REWRITTEN host (`<app>.<localDomain>`) and the hop's `http`
   * proto, but the browser is sitting on the app's public `https` origin. Deriving the cookie's
   * Domain from the forwarded host would emit `Domain=.<app>.<localDomain>`, which does not
   * domain-match the browser's host, so the cookie is discarded (RFC 6265) and the visitor loops.
   */
  private async setSessionCookie(res: Response, sessionId: string, req: Request, scope?: { host?: string; proto?: string }) {
    // Normalized for the same reason `/traefik` normalizes it: `getCookieDomain` gates on
    // `validator.isFQDN`, which rejects a port (`ci.lan:8443`) and a comma-joined repeat
    // (`hub.example.com, proxy.example`) alike. Either one silently drops the Domain attribute and
    // makes the cookie host-only — which on the LAN is not cosmetic: the `.ci.lan` domain cookie
    // is exactly what lets an app subdomain see the session, so SSO stops working over the
    // documented `:8443` tailnet path with nothing in the logs to say why.
    const host = normalizeForwardedHost(scope?.host ?? req.headers['x-forwarded-host']);
    // First hop only: a repeated header reaches Node comma-joined, and `https, http` matches
    // neither branch below, so an https request would silently be treated as plaintext.
    const proto = (scope?.proto ?? (req.headers['x-forwarded-proto'] as string | undefined))?.split(',')[0]?.trim();
    const domain = this.authService.getCookieDomain(host);
    // Derived from the SCHEME alone. `getCookieDomain` returns undefined for any non-FQDN host —
    // an IP, `localhost`, a single label — which is a statement about the cookie's Domain
    // attribute (omit it, make the cookie host-only), not about its transport. Gating `secure` on
    // it too meant an https request to such a host got a cookie with no `Secure` flag, which the
    // browser then sends in cleartext to the same host over http: the session id on the wire. The
    // documented `https://<ip>:8443` tailnet path is exactly that shape.
    const secure = proto === 'https';

    // The whole header bag is NOT logged. `LoggerService.log` JSON.stringifies every object
    // argument before winston gets to drop it, so the dump cost was paid at any level — and on
    // the edge-SSO consume path the bag carries `cookie: ci-hub-sid=<live session>` and
    // `x-forwarded-uri: …cihub_sso=<ticket>`, which is the very leak `/traefik` strips its own
    // log line to avoid. The derived values below are what this function actually decides on.
    this.logger.debug('Setting session cookie', { host, domain, proto, secure });

    if (this.config.get('userSettings').experimental.insecureCookie) {
      this.logger.warn('WARNING: Using insecure cookies. This is not recommended for production environments.');
      res.cookie(SESSION_COOKIE_NAME, sessionId, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: SESSION_COOKIE_MAX_AGE });
    } else {
      res.cookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: SESSION_COOKIE_MAX_AGE,
        domain,
      });
    }
  }

  /**
   * The Hub's browser-reachable origin (`https://<hubSubdomain>.<domain>`) together
   * with this appliance's org slug, or null when it isn't registered / provisioned
   * yet. The desktop session handoff opens this exact host so the planted cookie is
   * scoped to where the Hub's routes (memory-connect, forward-auth) actually live,
   * and the org slug bounds which sibling app hosts are an acceptable redirect target.
   */
  private async resolvePublicHub(): Promise<{ origin: string; orgSlug: string } | null> {
    const org = await this.deviceRegistration.getFirstDeviceRegistration();
    // `buildHubPublicOrigin` owns the construction AND the unprovisioned-domain sentinel, so a
    // change to what counts as "provisioned" cannot apply to memory-connect and not to here.
    const origin = buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain: this.publicDomainRoot() });

    if (!origin) {
      return null;
    }

    return { origin, orgSlug: org?.slug ?? '' };
  }

  /**
   * The root domain app/Hub hostnames are actually PUBLISHED under. Same precedence exposure-sync
   * uses to provision the tunnel (`userSettings.domain || domain`, exposure-sync.service.ts) and
   * the resolver uses to build its host map: an operator-set value wins until env regeneration
   * folds it back into `DOMAIN`. Reading only the env-derived `domain` builds origins at a root
   * the tunnel never published, and every hop that trusts such a value lands on an unresolvable
   * host.
   */
  private publicDomainRoot(): string {
    const cfg = this.config.getConfig();
    return cfg.userSettings?.domain || cfg.domain;
  }

  /** The local root the appliance's LAN hostnames are built with — same precedence as above. */
  private localDomainRoot(): string {
    const cfg = this.config.getConfig();
    return cfg.userSettings?.localDomain || cfg.localDomain;
  }

  /**
   * Whether `next` is a permitted post-handoff redirect target: the Hub's own
   * origin, or an https sibling that belongs to THIS appliance — a marketplace app
   * host under the appliance's public/local domain root whose subdomain ends at this
   * org's `-<orgSlug>` label boundary (every app host is `<app>-<…>-<orgSlug>` and
   * the Hub is `hub-<…>-<orgSlug>`). Scoping to the org slug keeps a co-tenant host
   * on the same shared registrable domain — a *different* org's `-<slug>` — out of
   * the allowlist. The Set-Cookie is scoped to the Hub host regardless, so this only
   * governs where the browser lands after the cookie is planted — closing the
   * open-redirect the raw `next` would otherwise allow.
   */
  private isSafeHandoffNext(next: string, hubOrigin: string, orgSlug: string): boolean {
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      return false;
    }

    if (url.origin === hubOrigin) {
      return true;
    }

    if (url.protocol !== 'https:' || !orgSlug) {
      return false;
    }

    // Same precedence as the origins these hosts are published under (see publicDomainRoot):
    // reading the env-only values rejected every sibling on an appliance whose operator had set a
    // custom domain — i.e. exactly the hosts the edge-SSO allowlist accepts.
    const domain = this.publicDomainRoot();
    const localDomain = this.localDomainRoot();
    const host = url.hostname.toLowerCase();
    const slugLabel = `-${orgSlug.toLowerCase()}`;

    return [domain, localDomain]
      .filter((root): root is string => Boolean(root) && root !== 'example.com')
      .some((root) => {
        const suffix = `.${root.toLowerCase()}`;
        if (host === root.toLowerCase() || !host.endsWith(suffix)) {
          return false;
        }
        // The subdomain must be one of this org's hosts: `<app>-<…>-<orgSlug>`, which
        // requires at least one label before the `-<orgSlug>` boundary.
        const label = host.slice(0, -suffix.length);
        return label.length > slugLabel.length && label.endsWith(slugLabel);
      });
  }

  @Post('/login')
  @ApiResponse({ type: LoginDto })
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const { sessionId, totpSessionId } = await this.authService.login(body);

    if (totpSessionId) {
      return { success: true, totpSessionId };
    }

    await this.setSessionCookie(res, sessionId, req);

    // Include session ID in response body for Tauri desktop app
    // (cross-origin cookies don't work in WebView2 on HTTP)
    return LoginDto.parse({ success: true, sessionId }, { reportOnly: true });
  }

  @Post('/verify-totp')
  @ApiResponse({ type: LoginDto })
  async verifyTotp(@Body() body: VerifyTotpBody, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const { sessionId } = await this.authService.verifyTotp(body);

    await this.setSessionCookie(res, sessionId, req);

    return LoginDto.parse({ success: true, sessionId }, { reportOnly: true });
  }

  @Post('/register')
  @ApiResponse({ type: RegisterDto })
  async register(@Body() body: RegisterBody, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const result = await this.authService.register(body);

    if (result.requiresEmailVerification) {
      return RegisterDto.parse({ success: true, requiresEmailVerification: true }, { reportOnly: true });
    }

    if (result.sessionId) {
      await this.setSessionCookie(res, result.sessionId, req);
    }

    return RegisterDto.parse({ success: true }, { reportOnly: true });
  }

  @Post('/logout')
  async logout(@Res() res: Response, @Req() req: Request) {
    res.clearCookie(SESSION_COOKIE_NAME);
    // The auth middleware accepts both cookie and X-CI-Hub-Session header (Tauri desktop
    // uses the header because WebView2 blocks cross-origin cookies). The logout handler
    // must do the same — without the header fallback the Tauri logout request finds no
    // session ID, hits the early return without sending a response, and the request hangs
    // indefinitely so onSuccess (and the subsequent page reload) never fires.
    const sessionId = req.cookies[SESSION_COOKIE_NAME] || req.get('x-ci-hub-session');

    if (sessionId) {
      await this.authService.logout(sessionId);
    }

    return res.status(204).send();
  }

  /**
   * Rotate the current session to a new ID with a fresh server-side TTL.
   * Desktop clients should call this before the 7-day expiry (e.g. around day 5)
   * and persist the returned sessionId.
   */
  @Post('/session/refresh')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: SessionRefreshDto })
  async refreshSession(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionId = req.cookies[SESSION_COOKIE_NAME] || req.get('x-ci-hub-session');
    if (!sessionId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', undefined, HttpStatus.UNAUTHORIZED);
    }

    const nextSessionId = await this.authService.refreshSession(sessionId);
    await this.setSessionCookie(res, nextSessionId, req);

    return SessionRefreshDto.parse({ sessionId: nextSessionId, issuedAt: Date.now() }, { reportOnly: true });
  }

  /**
   * Desktop session handoff — step 1 (mint).
   *
   * The Tauri desktop app authenticates with a localStorage/header session that
   * can't ride a top-level browser navigation, and the system browser holds no
   * `ci-hub-sid` cookie — so when the desktop hands a flow to the system browser
   * (opening a forward-auth'd app, or the memory-connect consent round-trip), every
   * Hub hop bounces to a second /login. This mints a single-use, 60s ticket bound to
   * the caller's current session. The desktop app then opens the returned Hub URL in
   * the system browser, which plants a cookie for a delegated session of the same user
   * (step 2) before continuing to `next`.
   *
   * Returns `{ url: null }` when no public Hub origin is known yet, so the caller
   * fails open to a plain external open rather than dead-ending.
   */
  @Post('/browser-handoff/mint')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: BrowserHandoffMintDto })
  async mintBrowserHandoff(@Body() body: BrowserHandoffMintBody, @Req() req: Request) {
    const sessionId = req.cookies[SESSION_COOKIE_NAME] || req.get('x-ci-hub-session');
    if (!sessionId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', undefined, HttpStatus.UNAUTHORIZED);
    }

    const hub = await this.resolvePublicHub();
    if (!hub) {
      return BrowserHandoffMintDto.parse({ url: null }, { reportOnly: true });
    }

    if (!this.isSafeHandoffNext(body.next, hub.origin, hub.orgSlug)) {
      throw new BadRequestException('Unsupported handoff target');
    }

    const ticket = crypto.randomUUID();
    // The target is stored server-side (never placed in a URL), so the consume
    // endpoint carries no open-redirect surface and the ticket alone re-materializes
    // the session as a browser cookie.
    this.cache.set(`browser_handoff:${ticket}`, JSON.stringify({ sessionId, next: body.next }), 60);

    return BrowserHandoffMintDto.parse({ url: `${hub.origin}/api/auth/browser-handoff?ticket=${encodeURIComponent(ticket)}` }, { reportOnly: true });
  }

  /**
   * Desktop session handoff — step 2 (consume). No AuthGuard: the single-use ticket
   * IS the credential. Reached as a top-level navigation in the system browser, it
   * mints a DELEGATED session for the ticket's user and plants that as the Hub session
   * cookie for the public Hub host (so the subsequent memory-connect / forward-auth
   * hops authenticate), then redirects to the server-stored `next`. A missing,
   * expired, or replayed ticket — or a minting session that died inside the window —
   * lands on `/` without setting anything.
   *
   * Login-CSRF hardening: because this plants a session cookie, an actor who can
   * mint a ticket (any authenticated Hub session) could otherwise lure a victim to
   * this URL and plant THEIR session into the victim's browser. The legitimate flow
   * only ever arrives as a fresh, user-initiated navigation opened by the desktop
   * app (`Sec-Fetch-Site: none`), so this ALLOW-lists only `none` (and an absent
   * header, for browsers that don't send Fetch Metadata) and rejects every
   * page-initiated navigation — `cross-site` (attacker page), `same-site`
   * (compromised sibling app), `same-origin`, or a spoofed multi-valued header —
   * before the ticket is touched. The reject path is intentionally silent: this
   * endpoint is unauthenticated, so a per-request log write would be a flood
   * amplifier (same reason the ticket-miss path below no longer deletes).
   */
  @Get('/browser-handoff')
  async consumeBrowserHandoff(@Query('ticket') ticket: string | undefined, @Req() req: Request, @Res() res: Response) {
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite !== undefined && fetchSite !== 'none') {
      return res.redirect('/');
    }

    if (!ticket) {
      return res.redirect('/');
    }

    const cacheKey = `browser_handoff:${ticket}`;
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      // Unknown/expired ticket. Return without deleting: this endpoint is
      // unauthenticated, so deleting on every miss would let a ticket flood force a
      // synchronous SQLite write (event-loop pressure) per bogus request.
      return res.redirect('/');
    }
    this.cache.del(cacheKey); // single-use — burn the real hit before acting on it.

    let sessionId: string;
    let next: string;
    try {
      const parsed = JSON.parse(cached) as { sessionId: string; next: string };
      sessionId = parsed.sessionId;
      next = parsed.next;
    } catch {
      return res.redirect('/');
    }

    // Defense in depth: re-validate the stored target against the current public Hub
    // origin before trusting it, in case registration changed since the mint.
    const hub = await this.resolvePublicHub();
    if (!sessionId || !next || !hub || !this.isSafeHandoffNext(next, hub.origin, hub.orgSlug)) {
      return res.redirect('/');
    }

    // Delegate a session, don't hand the desktop's own id over. Re-planting the SAME
    // id in the browser made the two contexts destroy each other: the handed-off
    // browser has no `ci-hub-session-issued-at` in its localStorage, so the Hub SPA
    // treats the session as legacy and rotates it on first load — and `rotateSession`
    // DELETES the id it rotates. The desktop was left holding a deleted session and
    // 401'd on its next call, collapsing to /login mid-flow (#944).
    //
    // A handoff means "log this browser in as me", so it should behave like any other
    // browser login: its own session id, its own lifecycle, rotating without reaching
    // back into the desktop.
    const userId = this.sessionManager.resolveSessionUserId(sessionId);
    if (userId === null) {
      // The minting session died inside the 60s ticket window (logged out, rotated, or
      // expired). Nothing to delegate — land on the Hub rather than plant a dead id.
      return res.redirect('/');
    }

    // This browser may already hold a live session for the SAME user (an earlier
    // handoff, or a direct login here). Keep it: re-minting on every open would leave a
    // trail of week-long sessions behind, and there is nothing to improve about a
    // session that already authenticates. A session belonging to anyone else is
    // replaced, not reused.
    const existingSessionId = req.cookies[SESSION_COOKIE_NAME];
    if (existingSessionId && this.sessionManager.resolveSessionUserId(existingSessionId) === userId) {
      return res.redirect(next);
    }

    const browserSessionId = await this.sessionManager.createSession(userId);
    await this.setSessionCookie(res, browserSessionId, req);
    return res.redirect(next);
  }

  /**
   * Start Portal OIDC (PKCE) login flow.
   *
   * Desktop opens Portal in the system browser, then returns to the Tauri app via cihub://.
   * Browser-based Hub logins continue to return directly to the Hub origin that initiated the flow.
   */
  @Get('/portal/start')
  async startPortalLogin(@Req() req: Request, @Res() res: Response, @Query('redirect_url') redirectUrl?: string, @Query('desktop') desktop?: string) {
    const isDesktop = desktop === '1' || desktop === 'true';
    const fallbackOrigin = resolveRequestOriginFallback(req);
    const redirectStartError = (errorCode: PortalSsoErrorCode, hubOrigin?: string | null) =>
      res.redirect(
        buildPortalSsoErrorRedirectUrl({
          hubOrigin: hubOrigin ?? null,
          desktop: isDesktop,
          errorCode,
          fallbackOrigin,
        }),
      );

    let hubOrigin: string;
    try {
      hubOrigin = resolveHubRequestOrigin(req);
    } catch {
      return redirectStartError('callback_error');
    }

    const callbackUrl = resolvePortalCallbackUrl(hubOrigin);

    const portalBaseUrl = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '');
    if (!portalBaseUrl) {
      return redirectStartError('not_configured', hubOrigin);
    }

    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    // Persist PKCE verifier + redirect target for the callback.
    // 10 min is plenty and avoids stale entries.
    const portalState: PortalSsoState = { codeVerifier, redirectUrl: redirectUrl || null, hubOrigin, desktop: isDesktop };
    this.cache.set(`portal_sso:${state}`, JSON.stringify(portalState), 10 * 60);

    const authorizeUrl = new URL('/api/auth/oauth2/authorize', portalBaseUrl);
    authorizeUrl.searchParams.set('client_id', 'ci-hub');
    authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid email profile');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    return res.redirect(authorizeUrl.toString());
  }

  @Get('/portal/callback')
  async portalCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('code') code?: string, @Query('state') state?: string) {
    const fallbackOrigin = resolveRequestOriginFallback(req);
    let desktop = false;
    const redirectError = (hubOrigin: string | null, errorCode: PortalSsoErrorCode) =>
      res.redirect(
        buildPortalSsoErrorRedirectUrl({
          hubOrigin,
          desktop,
          errorCode,
          fallbackOrigin,
        }),
      );

    try {
      if (!code || !state) {
        return redirectError(null, 'callback_error');
      }

      const publicPortalBaseUrl = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '');
      if (!publicPortalBaseUrl) {
        return redirectError(null, 'callback_error');
      }

      const cached = this.cache.get(`portal_sso:${state}`);
      this.cache.del(`portal_sso:${state}`);

      if (!cached) {
        return redirectError(null, 'state_expired');
      }

      let codeVerifier: string;
      let redirectUrl: string | null;
      let hubOrigin: string;

      try {
        const parsed = JSON.parse(cached) as PortalSsoState;
        codeVerifier = parsed.codeVerifier;
        redirectUrl = parsed.redirectUrl;
        hubOrigin = parsed.hubOrigin;
        desktop = parsed.desktop;
      } catch {
        return redirectError(null, 'callback_error');
      }

      const callbackUrl = resolvePortalCallbackUrl(hubOrigin);
      const exchange = await exchangePortalAuthorizationCode({
        publicPortalBaseUrl,
        callbackUrl,
        code,
        codeVerifier,
      });

      if (!exchange.ok) {
        this.logger.warn('Portal OAuth callback failed', {
          reason: exchange.reason,
          status: exchange.status,
          hubOrigin,
          portalBaseUrl: publicPortalBaseUrl,
        });
        return redirectError(hubOrigin, 'callback_error');
      }

      const email = exchange.email;
      let operator = await this.userRepository.getFirstOperator();

      if (!operator) {
        try {
          operator = await this.authService.bootstrapOperatorFromPortalEmail(email);
        } catch (error) {
          this.logger.warn('Portal OAuth callback failed to bootstrap local operator', { error });
          return redirectError(hubOrigin, 'callback_error');
        }
      } else if (operator.username.trim().toLowerCase() !== email.trim().toLowerCase()) {
        const operators = await this.userRepository.getOperators();

        if (operators.length === 1) {
          // A verified Portal OIDC login is authoritative for the sole operator on
          // single-user appliances — sync the local username so Companion Account
          // sign-in works after onboarding used a different local email.
          this.logger.warn('Portal login email differs from local operator; syncing from verified Portal identity', {
            portalEmail: email,
            operatorEmail: operator.username,
          });
          const normalizedEmail = email.trim().toLowerCase();
          await this.userRepository.updateUser(operator.id, { username: normalizedEmail });
          operator = { ...operator, username: normalizedEmail };
        } else {
          this.logger.warn('Portal login blocked: email mismatch', { portalEmail: email, operatorEmail: operator.username });
          return redirectError(hubOrigin, 'account_mismatch');
        }
      }

      const sessionId = await this.sessionManager.createSession(operator.id);
      await this.setSessionCookie(res, sessionId, req);

      if (desktop) {
        const desktopToken = crypto.randomUUID();
        const exchangePayload: PortalDesktopExchange = {
          sessionId,
          redirectPath: toDesktopRedirectPath(redirectUrl, hubOrigin),
        };
        this.cache.set(`portal_sso_desktop:${desktopToken}`, JSON.stringify(exchangePayload), 60);
        return res.redirect(buildPortalDesktopDeepLink(desktopToken, hubOrigin));
      }

      // Redirect back to the requested URL if it's same-origin; otherwise go home.
      const safeRedirect = resolveSameOriginRedirectUrl(redirectUrl, hubOrigin);
      if (safeRedirect) {
        return res.redirect(safeRedirect);
      }

      return res.redirect(new URL('/home', hubOrigin).toString());
    } catch (error) {
      this.logger.error('Portal OAuth callback crashed', error);
      return redirectError(null, 'callback_error');
    }
  }

  /**
   * Returns a Portal account email hint for the login button when available.
   * Prefers the configured Hub operator, then probes the Portal session using
   * cookies forwarded from the browser (when present).
   */
  @Get('/portal/session-hint')
  @ApiResponse({ type: PortalSessionHintDto })
  async portalSessionHint(@Req() req: Request) {
    const portalBaseUrl = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '') || null;

    if (!portalBaseUrl) {
      return PortalSessionHintDto.parse({ email: null, portalBaseUrl: null, source: null }, { reportOnly: true });
    }

    const operator = await this.userRepository.getFirstOperator();
    if (operator?.username?.trim()) {
      return PortalSessionHintDto.parse(
        {
          email: operator.username.trim(),
          portalBaseUrl,
          source: 'hub_operator',
        },
        { reportOnly: true },
      );
    }

    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    const portalEmail = await fetchPortalSessionEmail({
      publicPortalBaseUrl: portalBaseUrl,
      cookieHeader,
    });

    if (portalEmail) {
      return PortalSessionHintDto.parse(
        {
          email: portalEmail,
          portalBaseUrl,
          source: 'portal_session',
        },
        { reportOnly: true },
      );
    }

    return PortalSessionHintDto.parse({ email: null, portalBaseUrl, source: null }, { reportOnly: true });
  }

  @Get('/portal/desktop-exchange')
  @ApiResponse({ type: PortalDesktopExchangeDto })
  async exchangePortalDesktopLogin(@Query('token') token?: string) {
    if (!token) {
      throw new BadRequestException('Missing desktop exchange token');
    }

    const cacheKey = `portal_sso_desktop:${token}`;
    const cached = this.cache.get(cacheKey);
    this.cache.del(cacheKey);

    if (!cached) {
      throw new BadRequestException('Invalid or expired desktop exchange token');
    }

    try {
      const parsed = JSON.parse(cached) as PortalDesktopExchange;
      return PortalDesktopExchangeDto.parse(parsed, { reportOnly: true });
    } catch {
      throw new BadRequestException('Malformed desktop exchange payload');
    }
  }

  @Patch('/username')
  @UseGuards(AuthGuard)
  async changeUsername(@Body() body: ChangeUsernameBody, @Req() req: Request, @Res() res: Response) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.authService.changeUsername({ userId, ...body });

    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(204).send();
  }

  @Patch('/password')
  @UseGuards(AuthGuard)
  async changePassword(@Body() body: ChangePasswordBody, @Req() req: Request, @Res() res: Response) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.authService.changePassword({ userId, ...body });

    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(204).send();
  }

  @Patch('/totp/get-uri')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: GetTotpUriDto })
  async getTotpUri(@Body() body: GetTotpUriBody, @Req() req: Request) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    const res = await this.authService.getTotpUri({ userId, ...body });
    return GetTotpUriDto.parse(res, { reportOnly: true });
  }

  @Patch('/totp/setup')
  @UseGuards(AuthGuard)
  async setupTotp(@Body() body: SetupTotpBody, @Req() req: Request) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.authService.setupTotp({ userId, totpCode: body.code });
  }

  @Patch('/totp/disable')
  @UseGuards(AuthGuard)
  async disableTotp(@Body() body: DisableTotpBody, @Req() req: Request) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.authService.disableTotp({ userId, ...body });
  }

  @Post('/reset-password')
  @ApiResponse({ type: ResetPasswordDto })
  async resetPassword(@Body() body: ResetPasswordBody) {
    const { email } = await this.authService.changeOperatorPassword(body);

    return ResetPasswordDto.parse({ success: true, email }, { reportOnly: true });
  }

  @Delete('/reset-password')
  async cancelResetPassword() {
    await this.authService.cancelPasswordChangeRequest();
  }

  @Get('/reset-password')
  @ApiResponse({ type: CheckResetPasswordRequestDto })
  async checkResetPasswordRequest() {
    const isPending = await this.authService.checkPasswordChangeRequest();

    return CheckResetPasswordRequestDto.parse({ isRequestPending: isPending }, { reportOnly: true });
  }

  @Post('/password-reset/request')
  @ApiResponse({ type: PasswordResetRequestDto })
  async requestPasswordReset(@Body() body: PasswordResetRequestBody, @Req() req: Request) {
    const { domain, localDomain } = this.config.getConfig();
    const hubOrigin = resolveTrustedReturnOrigin(req, { domain, localDomain });

    let deviceId = body.deviceId;
    if (!deviceId) {
      try {
        deviceId = (await this.registrationService.getDeviceId()) || undefined;
      } catch {
        deviceId = undefined;
      }
    }

    await this.authService.requestPasswordReset({
      email: body.email,
      returnOrigin: hubOrigin,
      deviceId,
      ipAddress: req.ip,
    });

    return PasswordResetRequestDto.parse(
      { success: true, message: 'If this email is registered, you will receive reset instructions shortly.' },
      { reportOnly: true },
    );
  }

  @Get('/password-reset/verify/:token')
  @ApiResponse({ type: PasswordResetVerifyResponseDto })
  async verifyPasswordResetToken(@Req() req: Request) {
    const token = String(req.params.token ?? '');
    const result = await this.authService.verifyPasswordResetToken(token);
    return PasswordResetVerifyResponseDto.parse(result, { reportOnly: true });
  }

  @Post('/password-reset/complete')
  @ApiResponse({ type: PasswordResetCompleteDto })
  async completePasswordReset(@Body() body: PasswordResetCompleteBody, @Req() req: Request) {
    await this.authService.completePasswordReset({ token: body.token, newPassword: body.newPassword, ipAddress: req.ip });

    return PasswordResetCompleteDto.parse(
      { success: true, message: 'Password updated. You can now log in with your new password.' },
      { reportOnly: true },
    );
  }

  /**
   * Split a forwarded request-target into its edge-SSO ticket and the URL without it, in ONE
   * parse. The ticket must never survive past its consume hop — it would linger in the app's logs
   * and the address bar, and a failed consume falling through to a fresh mint must not stack a
   * second ticket onto the URL.
   *
   * Every OTHER query param survives BYTE-FOR-BYTE, ticket or no ticket. Round-tripping them
   * through URLSearchParams re-encodes params the Hub has no business rewriting —
   * `?q=a%20b&s=~z&flag` comes back as `?q=a+b&s=%7Ez&flag=` — which corrupts signature-checked or
   * strictly-parsed query strings on the way back to the app, and the cleaned URI is precisely
   * what the browser lands on once a ticket has been burned or has failed to consume.
   */
  private parseForwardedUri(uri: string): { ticket: string | null; cleanUri: string } {
    const queryStart = uri.indexOf('?');
    if (queryStart === -1 || !uri.includes(`${EDGE_SSO_TICKET_PARAM}=`)) {
      return { ticket: null, cleanUri: uri || '/' };
    }

    // Split the query at the `&` boundaries and hand back every OTHER segment byte-for-byte.
    // Routing the survivors through URLSearchParams (which is what `searchParams.delete` then
    // re-serialising does) would rewrite them — `?q=a%20b&s=~z&flag` comes back as
    // `?q=a+b&s=%7Ez&flag=` — and this cleaned URI is exactly what the browser lands on after a
    // burned or failed ticket, so that corruption would reach the app.
    const path = uri.slice(0, queryStart) || '/';
    const segments = uri.slice(queryStart + 1).split('&');
    const kept: string[] = [];
    let ticket: string | null = null;

    for (const segment of segments) {
      const eq = segment.indexOf('=');
      // Match the param NAME exactly, never the substring: `?xcihub_sso=1` contains the marker but
      // is a DIFFERENT param, and treating it as a ticket "cleans" to an identical URL — an
      // endless self-redirect.
      if (eq !== -1 && segment.slice(0, eq) === EDGE_SSO_TICKET_PARAM) {
        // EVERY occurrence is dropped, but only the FIRST is read as the ticket. Keeping the
        // extras would strand the visitor permanently: the mint below builds its target from this
        // cleaned URI and appends the fresh ticket at the END, while the consume reads the FIRST —
        // so a surviving stale `cihub_sso` is what every consume would look up. It misses, falls
        // through to another mint, and three rounds later the loop guard serves its 409 dead end.
        if (ticket === null) {
          const raw = segment.slice(eq + 1);
          try {
            ticket = decodeURIComponent(raw);
          } catch {
            // Malformed percent-escapes cannot name a minted ticket; keep the raw value so the
            // lookup below misses instead of throwing a 500 out of the forward-auth hop.
            ticket = raw;
          }
        }
        continue;
      }
      kept.push(segment);
    }

    if (ticket === null) {
      return { ticket: null, cleanUri: uri };
    }
    return { ticket: ticket || null, cleanUri: kept.length ? `${path}?${kept.join('&')}` : path };
  }

  /**
   * Whether the request reached us through the Cloudflare tunnel. Cloudflare stamps `cf-ray` at
   * its edge, so its presence means the browser is on the public internet — the one signal that
   * distinguishes a remote visitor from a LAN one, since cloudflared rewrites Host to the same
   * origin server name for both. One definition, because `/traefik` and `/edge-sso` are two halves
   * of the same exchange and must agree about which side of the tunnel the visitor is on.
   */
  private viaCloudflareTunnel(req: Request): boolean {
    return Boolean(req.headers['cf-ray']);
  }

  /**
   * The address to send a browser back to from a forward-auth subrequest, as an ABSOLUTE URL.
   *
   * Absolute is not a style choice: Traefik runs a non-2xx forward-auth `Location` through Go's
   * `http.Response.Location()`, which resolves a relative value against the auth-server address
   * (`http://ci-os-hub:5002/api/auth/traefik`) and overwrites the header with the result. A
   * relative Location therefore reaches the browser as an unresolvable Docker-internal name.
   *
   * A tunnel visitor gets the app's PUBLIC hostname — the forwarded host is the rewritten
   * `<app>.<localDomain>` origin server name, which only resolves on the LAN. Everyone else gets
   * the host they arrived on, port included.
   *
   * Returns null when neither is available, which the caller reads as "do not redirect". There is
   * no safe fallback: the LAN name is unreachable for a tunnel visitor, and a relative Location is
   * the one shape guaranteed to be rewritten to the internal address. Since the only reason to
   * redirect here is to tidy a ticket that has ALREADY been burned, not redirecting costs a stale
   * param in the app's log and keeps the visitor on a page that works.
   *
   * `path` is re-pinned to exactly one leading slash: `X-Forwarded-Uri` is the client's own
   * request target, and `//evil.com/` is a legal origin-form path that reaches us intact — a
   * browser reads `Location: //evil.com/` as a protocol-relative jump off the appliance.
   */
  private async buildReturnUrl(input: {
    forwardedHost: string;
    rawHost: string;
    proto: string;
    viaTunnel: boolean;
    path: string;
  }): Promise<string | null> {
    const safePath = `/${input.path.replace(/^[/\\]+/, '')}`;

    if (input.viaTunnel) {
      const publicHost = await this.forwardAuthSecrets.resolvePublicHostForHost(input.forwardedHost);
      return publicHost ? `https://${publicHost}${safePath}` : null;
    }

    return input.rawHost ? `${input.proto}://${input.rawHost}${safePath}` : null;
  }

  /**
   * Validate an edge-SSO redirect target: a well-formed http(s) URL whose hostname the secret
   * resolver's host map vouches for — an exact allowlist of "router hostnames of apps installed
   * on THIS appliance", which is a strictly tighter check than the `-<orgSlug>` label heuristic
   * the desktop handoff uses (and, unlike it, also works on unregistered LAN-only appliances
   * whose app hosts carry no org slug). Plain http is allowed only under the appliance's OWN
   * localDomain: LAN visitors legitimately arrive over http, but a public sibling must never be
   * handed a downgraded scheme.
   *
   * Local open (`localhost` / `127.0.0.1:{port}`) never uses this path — ADR 001 + ADR 002.
   * Reject those hosts explicitly so a forged redirect cannot mint a session-planting ticket for
   * the loopback open URL.
   */
  private async validateEdgeSsoTarget(redirect: string | undefined): Promise<URL | null> {
    // `typeof`, not just truthiness: Express hands a REPEATED query key to `@Query` as an array,
    // and an array is truthy. `new URL(['https://app.example.com/', 'x'])` stringifies to
    // `https://app.example.com/,x`, whose hostname the allowlist below happily vouches for — so
    // `?redirect=<app>&redirect=x` would mint a real ticket for a corrupted target.
    if (typeof redirect !== 'string' || !redirect) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(redirect);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    // ADR 002: ticket SSO is for hostname-routed siblings (public / LAN Traefik), never loopback.
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return null;
    }
    if (url.protocol === 'http:') {
      const localDomain = this.localDomainRoot();
      if (!localDomain || localDomain === 'example.com' || !url.hostname.endsWith(`.${localDomain.toLowerCase()}`)) {
        return null;
      }
    }
    // `url.hostname` is already lowercased by the URL parser — no further normalization needed.
    const appUrn = await this.forwardAuthSecrets.resolveAppUrnForHost(url.hostname);
    return appUrn ? url : null;
  }

  @Get('/traefik')
  async traefik(@Req() req: Request, @Res() res: Response) {
    const forwardedHost = normalizeForwardedHost(req.headers['x-forwarded-host']);
    const rawHost = rawForwardedHost(req.headers['x-forwarded-host']);
    // Deliberately NOT comma-split like the host and proto below: a comma is a legal sub-delim in
    // both a path and a query (`/items/1,2,3`, `?q=a,b`), so "first hop wins" cannot be recovered
    // here without truncating ordinary request targets.
    const uri = (req.headers['x-forwarded-uri'] as string | undefined) || '/';
    // First hop only, same as the forwarded host: a REPEATED header reaches Node as one
    // comma-joined string, and `https, http` fed into `new URL()` below is not a scheme — it
    // throws, and the visitor sees a 500 out of the forward-auth hop.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
    const viaTunnel = this.viaCloudflareTunnel(req);
    const { ticket, cleanUri } = this.parseForwardedUri(uri);

    if (req.user) {
      // A ticket that reaches an already-authenticated request was never consumed (the LAN
      // domain cookie short-circuited the exchange). Burn it — leaving it live would keep a
      // session-planting credential replayable from any browser for the rest of its TTL — and
      // strip it with one extra redirect so the URL never reaches the app's logs or address bar.
      if (ticket) {
        // Burn only a ticket that is actually there. An unconditional delete would let anyone
        // holding a session force a synchronous store write per request by appending a junk
        // `cihub_sso=` to any app URL — the same flood amplifier the unauthenticated consume
        // below refuses to expose, on the endpoint that runs for EVERY request to EVERY app.
        const lingeringKey = `${EDGE_SSO_CACHE_PREFIX}${ticket}`;
        if (this.cache.get(lingeringKey)) {
          this.cache.del(lingeringKey);
        }
        // ABSOLUTE, and pinned to a host we chose. Traefik does not hand a forward-auth
        // `Location` back untouched: for a non-2xx it runs the header through Go's
        // `http.Response.Location()`, which resolves a relative value against the AUTH-SERVER
        // address (`http://ci-os-hub:5002/api/auth/traefik`) and rewrites the header with the
        // result — so a relative Location reaches the browser as an internal Docker name it
        // cannot resolve, and leaks that name and port. The path is re-pinned to exactly one
        // leading slash for the same reason the frontend resolves before judging: a request
        // target of `//evil.com/` is a legal origin-form path that survives Go and Express
        // untouched, and a browser reads `Location: //evil.com/` as protocol-relative.
        //
        // Null means no address the browser can reach is known; the ticket is already burned, so
        // fall through to the signed pass-through and let the visitor keep the working page
        // rather than bounce them somewhere that does not resolve for the sake of a tidy URL.
        const returnUrl = await this.buildReturnUrl({ forwardedHost, rawHost, proto, viaTunnel, path: cleanUri });
        if (returnUrl) {
          return res.status(302).redirect(returnUrl);
        }
      }

      // Sign the identity header so a consumer (e.g. CI-Server, ci-import-tools) can
      // verify it was issued by the Hub and not forged by another container on
      // ci_os_hub_network. The signing secret is PER TARGET APP (CI-Engineering#74):
      // the resolver maps X-Forwarded-Host to the destination app and signs with the
      // secret that app's env actually holds, so one app can never forge an identity
      // header a sibling accepts. Unknown hosts fall back to the Hub-global secret.
      const resolved = await this.forwardAuthSecrets.resolveForHost(forwardedHost);
      this.logger.debug('User authenticated for Traefik forward auth', {
        username: req.user.username,
        secretSource: resolved.source,
        targetApp: resolved.appUrn,
      });
      const signed = buildSignedForwardAuthHeaders(resolved.secret, req.user.username);
      for (const [header, value] of Object.entries(signed)) {
        res.setHeader(header, value);
      }

      return res.status(200).send();
    }

    // Without a forwarded host there is nothing to route back to — refuse plainly instead of
    // crashing into a 500 (which Traefik would surface to the visitor as a server error).
    if (!forwardedHost) {
      return res.status(401).send();
    }

    // One lookup per request. The consume's host binding and the mint's return address both ask
    // the same question of the same host map, and a failed consume falls straight through to the
    // mint — so the unmemoised pair cost two lookups on exactly the path that already loops.
    let cachedPublicHost: string | null | undefined;
    const resolvePublicHostOnce = async (): Promise<string | null> => {
      if (cachedPublicHost === undefined) {
        cachedPublicHost = await this.forwardAuthSecrets.resolvePublicHostForHost(forwardedHost);
      }
      return cachedPublicHost;
    };

    // `cleanUri`, never the raw one: the raw target carries `cihub_sso=<ticket>`, and a ticket is a
    // session-planting credential. Writing it to the Hub's own log is the same leak the redirects
    // below go out of their way to avoid in the app's log and the address bar.
    this.logger.debug('Unauthenticated Traefik forward auth request', { uri: cleanUri, proto, host: forwardedHost });

    // Edge-SSO ticket consume (CI-Engineering#77). The Hub and an app on PUBLIC hostnames are
    // cookie-scope siblings, so a Hub login can never plant a cookie the app host sees. Instead
    // /edge-sso redirects back here carrying a single-use ticket, and — because Traefik returns a
    // forward-auth non-2xx response to the browser verbatim, Set-Cookie included — this exchange
    // plants the session cookie scoped to the APP host, then retries the clean URL, which now
    // authenticates. Every failure mode falls through to the login redirect below (which mints a
    // fresh ticket): the flow can loop back to login, but never dead-ends.
    if (ticket) {
      const cacheKey = `${EDGE_SSO_CACHE_PREFIX}${ticket}`;
      const cached = this.cache.get(cacheKey);
      // A miss is left undeleted deliberately — this endpoint is unauthenticated, and deleting on
      // every bogus ticket would let a flood force a synchronous store write per request (same
      // hardening as the browser-handoff consume).
      if (cached) {
        this.cache.del(cacheKey); // single-use — burn the real hit before acting on it.
        let sessionId = '';
        let targetHost = '';
        let targetUrl = '';
        try {
          ({ sessionId, targetHost, targetUrl } = JSON.parse(cached) as { sessionId: string; targetHost: string; targetUrl: string });
        } catch {
          // fall through to the login redirect
        }

        // Host binding: a ticket minted for one app must never plant a cookie on a sibling.
        //
        // The bound host is the PUBLIC one the browser is actually on, but a request arriving
        // through the tunnel carries the rewritten origin server name (`<app>.<localDomain>`) —
        // the two are different strings for the same app, so a direct comparison rejects every
        // remote visitor, i.e. exactly the population this flow exists for. Accept either the
        // forwarded host itself (LAN, where they coincide) or the public hostname that host maps
        // to. The check stays exact — both sides resolve through the same host map — so a ticket
        // for app A presented on app B still fails.
        const publicForHost = targetHost && targetHost !== forwardedHost ? await resolvePublicHostOnce() : null;
        const hostMatches = Boolean(targetHost) && (targetHost === forwardedHost || targetHost === publicForHost);

        // Parsed defensively even though the mint validated it: a throw here would escape as a
        // 500 the visitor sees as a server error, breaking the "every failure mode falls through
        // to the login redirect" property this whole block rests on.
        let ticketTarget: URL | null = null;
        try {
          ticketTarget = targetUrl ? new URL(targetUrl) : null;
        } catch {
          ticketTarget = null;
        }

        // The session must still resolve — a ticket outliving its session plants nothing.
        if (sessionId && ticketTarget && hostMatches && this.sessionManager.resolveSessionUserId(sessionId)) {
          // Scope the cookie and the retry to the address the BROWSER is on (the minted target),
          // never to the forwarded host: through the tunnel the latter is a `.<localDomain>` name
          // the browser would reject the cookie for and could not resolve on retry.
          await this.setSessionCookie(res, sessionId, req, {
            host: ticketTarget.hostname,
            proto: ticketTarget.protocol.replace(':', ''),
          });
          return res.status(302).redirect(ticketTarget.toString());
        }
      }
    }

    // Where to send the visitor to log in. The tunnel rewrites every visitor's Host to the origin
    // server name (`<app>.<localDomain>`), so the forwarded host identifies the TARGET APP but
    // says nothing about the caller — `cf-ray` does: Cloudflare stamps it at the edge, so its
    // presence means the browser is on the public internet and must be sent to the Hub's PUBLIC
    // origin with the app's PUBLIC hostname as the return address (the `.ci.lan` names it arrived
    // under only resolve on the LAN). A LAN client spoofing `cf-ray` merely picks the public login
    // origin for itself — harmless. Without `cf-ray` (or before registration provides a public
    // origin) this preserves the historical LAN shape: the Hub is assumed to sit at the root of
    // the app's domain, and the `.ci.lan`-scoped session cookie makes the ticket exchange a no-op.
    const publicHub = viaTunnel ? await this.resolvePublicHub() : null;
    const publicAppHost = publicHub ? await resolvePublicHostOnce() : null;

    let hubOrigin: string;
    let target: string;
    if (publicHub && publicAppHost) {
      hubOrigin = publicHub.origin;
      target = `https://${publicAppHost}${cleanUri}`;
    } else if (publicHub) {
      // Through the tunnel, but the forwarded host maps to no app we can name a public return
      // address for (a host map that has not caught up with a fresh install, or a router created
      // outside the app lifecycle). The LAN shape below would hand this remote browser a
      // `.<localDomain>` origin it cannot resolve — a hard dead end with no way back. Send it to
      // the Hub's public login instead: reachable, and retrying the original URL succeeds once
      // the map catches up.
      // debug, not warn: this endpoint is unauthenticated, so a per-request log write is a flood
      // amplifier — the same reason the ticket-miss path below does not write on every miss.
      this.logger.debug(`[edge-sso] no public hostname for forwarded host ${forwardedHost}; sending the visitor to the Hub login`);
      return res.status(302).redirect(new URL('/login', publicHub.origin).toString());
    } else {
      // rawHost, not the normalized key: a LAN visitor reaching Traefik on a nonstandard port
      // (the documented `:8443` tailnet path) must keep it in both the Hub origin and the return
      // address, or both point at :443 where nothing answers.
      // An IP literal has no parent domain to lop a label off. `10.0.0.5` yields `0.0.5`, which
      // `new URL` silently re-expands to the unrelated host `0.0.0.5`; a bracketed IPv6 literal
      // yields `0.0.5]`, where `]` is a forbidden host code point and `new URL` THROWS — a 500
      // straight out of the forward-auth hop, i.e. exactly the crash the guard below was added to
      // eliminate, on the documented `https://<ip>:8443` tailnet path.
      const rootDomain = net.isIP(forwardedHost.replace(/^\[|]$/g, '')) ? '' : rawHost.split('.').slice(1).join('.');
      // A single-label host (`localhost`, a bare container name) leaves nothing to derive a Hub
      // origin from — refuse plainly. The old code fed the empty root into new URL() and 500'd.
      if (!rootDomain) {
        return res.status(401).send();
      }
      hubOrigin = `${proto}://${rootDomain}`;
      target = `${proto}://${rawHost}${cleanUri}`;

      // The edge-SSO hop only accepts a target the resolver's host map vouches for, and answers
      // anything else with a JSON 400 a browser cannot act on. A forward-auth host the map does
      // not know — a router created outside the app lifecycle, or an app installed since the last
      // rebuild (30s TTL) — must therefore keep the historical direct login redirect, which needs
      // no allowlist. Nothing is lost: on the LAN the Hub cookie is domain-scoped across the whole
      // root, so the ticket exchange was a no-op here anyway.
      if (!(await this.forwardAuthSecrets.resolveAppUrnForHost(forwardedHost))) {
        const loginUrl = new URL('/login', hubOrigin);
        loginUrl.searchParams.set('redirect_url', target);
        loginUrl.searchParams.set('app', rawHost.split('.')[0] ?? '');
        return res.status(302).redirect(loginUrl.toString());
      }
    }

    const ssoUrl = new URL('/api/auth/edge-sso', hubOrigin);
    ssoUrl.searchParams.set('redirect', target);

    this.logger.debug('Redirecting to edge SSO', { ssoUrl: ssoUrl.toString(), target, viaTunnel });

    return res.status(302).redirect(ssoUrl.toString());
  }

  /**
   * Edge-SSO mint (CI-Engineering#77, ADR 002) — the Hub-origin half of the exchange consumed in
   * `/traefik` above. Reached by the redirect there; sends the visitor through the normal Hub
   * login when unauthenticated (`redirect_url` loops back HERE, which requires the login page to
   * accept a same-origin absolute URL), and once a session exists mints a single-use, 60s ticket
   * bound to the target app's hostname and bounces the browser back to the app carrying it.
   *
   * Why tickets exist: public Hub and app hosts are cookie-scope siblings. A Hub session cookie
   * never reaches the app host. Nested-under-Hub hostnames were rejected (cert/ops surface);
   * shared-root cookie Domain is forbidden (cross-tenant). See docs/adr/002-sibling-public-hostnames-edge-sso.md.
   *
   * Tunnel visitors (`cf-ray`) must use public Hub/app return URLs — cloudflared rewrites Host to
   * `*.localDomain` origins that only resolve on the LAN. Local `127.0.0.1:{port}` open never
   * enters this flow (ADR 001).
   *
   * No AuthGuard: this must answer a browser navigation with redirects, never a 401 JSON body.
   *
   * Login-CSRF note: unlike the browser-handoff consume, this exchange sits mid-redirect-chain,
   * where Sec-Fetch-Site reflects the chain's INITIATOR — gating on it would loop every
   * legitimate cross-site entry (a link to the app from mail or a portal). The mitigations are
   * the ticket's host binding, single-use burn, 60s TTL, and that minting requires an
   * authenticated session on this appliance. The residual — an authenticated operator luring
   * someone into their own session — is the standard IdP-initiated-SSO trade-off.
   */
  @Get('/edge-sso')
  async edgeSso(@Query('redirect') redirect: string | undefined, @Req() req: Request, @Res() res: Response) {
    const target = await this.validateEdgeSsoTarget(redirect);
    if (!target) {
      throw new BadRequestException('Unsupported edge SSO target');
    }

    const sessionId = req.user ? req.cookies[SESSION_COOKIE_NAME] || req.get('x-ci-hub-session') : undefined;
    if (!sessionId) {
      // Not logged in on this origin (or Bearer-authed, which has no session to hand off): run
      // the normal login flow and come back here. The redirect_url must be ABSOLUTE — the portal
      // OIDC callback validates it as same-origin-absolute, and the login page accepts it.
      //
      // Resolved once, and forced to https for a tunnel visitor: this endpoint is itself reached
      // through the plain-HTTP tunnel entrypoint, so the forwarded proto is `http` while the
      // browser is on `https`. An http self-URL survives the round trip only to be rejected as
      // cross-origin by the login page's redirect check, silently stranding the visitor on /home.
      // Case-INSENSITIVE: scheme names are case-insensitive per RFC 3986 and the origin is built
      // by interpolating `x-forwarded-proto` verbatim, so an upstream sending `HTTP` would slip
      // past an anchored `/^http:/` and strand the visitor on /home — silently, because
      // `new URL` lowercases the scheme afterwards and the missed upgrade leaves no trace.
      const requestOrigin = resolveRequestOriginFallback(req);
      const origin = this.viaCloudflareTunnel(req) ? requestOrigin.replace(/^http:/i, 'https:') : requestOrigin;
      const selfUrl = new URL('/api/auth/edge-sso', origin);
      selfUrl.searchParams.set('redirect', target.toString());
      const loginUrl = new URL('/login', origin);
      loginUrl.searchParams.set('redirect_url', selfUrl.toString());
      loginUrl.searchParams.set('app', target.hostname.split('.')[0] ?? '');
      return res.status(302).redirect(loginUrl.toString());
    }

    // Loop guard: a browser that refuses the planted cookie would bounce app → here → app
    // forever, each pass minting a fresh ticket. Cap the mint rate per (session, app host) and
    // break the loop with an explanation instead of a redirect.
    const counterKey = `${EDGE_SSO_COUNTER_PREFIX}${sessionId}:${target.hostname}`;
    const mints = Number.parseInt(this.cache.get(counterKey) ?? '0', 10) || 0;
    if (mints >= EDGE_SSO_MAX_MINTS_PER_MINUTE) {
      return res
        .status(409)
        .type('html')
        .send(
          '<!doctype html><html><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">' +
            '<h1>Cookies required</h1><p>Signing in to this app requires cookies, and your browser ' +
            'does not appear to be accepting them. Enable cookies for this site and try again.</p>' +
            '</body></html>',
        );
    }
    // Fixed window, not sliding: re-arming the full TTL on every mint keeps extending the window,
    // so three sign-ins spaced under a minute apart eventually trip the cap on a browser that is
    // accepting cookies perfectly well — and the 409 page is a dead end with no way forward.
    const windowEndsAt = this.cache.getExpirationAt(counterKey);
    const windowTtl = windowEndsAt ? Math.max(1, Math.ceil((windowEndsAt - Date.now()) / 1000)) : EDGE_SSO_MINT_WINDOW_SECONDS;
    this.cache.set(counterKey, String(mints + 1), windowTtl);

    const ticket = crypto.randomUUID();
    // The ticket is the only value that travels in a URL; the session it resolves to stays
    // server-side, bound to the one hostname the consume side will accept it for. The full target
    // is stored with it so the consume hop redirects to the address the BROWSER used — scheme and
    // port included — instead of trying to reconstruct it from the tunnel-rewritten forwarded
    // host, which names the same app but is unreachable from outside the LAN.
    const targetUrl = target.toString();
    this.cache.set(
      `${EDGE_SSO_CACHE_PREFIX}${ticket}`,
      JSON.stringify({ sessionId, targetHost: target.hostname, targetUrl }),
      EDGE_SSO_TICKET_TTL_SECONDS,
    );

    // Appended as a raw query segment rather than via `searchParams.set`: that setter re-serializes
    // the WHOLE query through URLSearchParams, which rewrites `%20`→`+`, `~`→`%7E` and a bare
    // `flag` to `flag=` — the exact corruption `parseForwardedUri` goes out of its way to avoid,
    // and it reaches the app whenever this hop's URL is the one the browser ends up on (a ticket
    // that arrives already authenticated, or a consume that falls through to a fresh mint).
    const ticketParam = `${EDGE_SSO_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
    target.search = target.search ? `${target.search}&${ticketParam}` : `?${ticketParam}`;
    return res.status(302).redirect(target.toString());
  }
}
