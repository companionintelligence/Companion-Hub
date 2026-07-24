import crypto from 'node:crypto';
import { SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_NAME } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { buildSignedForwardAuthHeaders } from './utils/forward-auth-signing';
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

  private async setSessionCookie(res: Response, sessionId: string, req: Request) {
    const host = req.headers['x-forwarded-host'] as string | undefined;
    const proto = req.headers['x-forwarded-proto'] as string | undefined;
    const domain = this.authService.getCookieDomain(host);
    const secure = Boolean(domain) && proto === 'https';

    this.logger.debug('Request headers', req.headers);
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
    const domain = this.config.getConfig().domain;

    if (!org?.hubSubdomain || !domain || domain === 'example.com') {
      return null;
    }

    return { origin: `https://${org.hubSubdomain}.${domain}`, orgSlug: org.slug ?? '' };
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

    const { domain, localDomain } = this.config.getConfig();
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
   * the system browser, which plants the cookie (step 2) before continuing to `next`.
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
   * plants the Hub session cookie for the public Hub host (so the subsequent
   * memory-connect / forward-auth hops authenticate), then redirects to the
   * server-stored `next`. A missing, expired, or replayed ticket lands on `/`
   * without setting anything.
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

    await this.setSessionCookie(res, sessionId, req);
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

  /** Lowercase, port-stripped view of a forwarded host — the same normalization the secret
   *  resolver applies, so ticket host-binding and host-map lookups agree on the key. */
  private normalizeForwardedHost(value: string | string[] | undefined): string {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') {
      return '';
    }
    return raw.trim().toLowerCase().replace(/:\d+$/, '');
  }

  /**
   * The forwarded request's URL with any `cihub_sso` ticket removed. The ticket must never
   * survive past its consume hop: it would linger in the app's logs and the address bar, and a
   * failed consume falling through to a fresh mint must not stack a second ticket onto the URL.
   */
  private cleanForwardedUri(uri: string | undefined): string {
    try {
      const url = new URL(uri || '/', 'http://placeholder');
      url.searchParams.delete(EDGE_SSO_TICKET_PARAM);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '/';
    }
  }

  /**
   * Validate an edge-SSO redirect target: a well-formed http(s) URL whose hostname the secret
   * resolver's host map vouches for — an exact allowlist of "router hostnames of apps installed
   * on THIS appliance", which is a strictly tighter check than the `-<orgSlug>` label heuristic
   * the desktop handoff uses (and, unlike it, also works on unregistered LAN-only appliances
   * whose app hosts carry no org slug). Plain http is allowed only under the appliance's OWN
   * localDomain: LAN visitors legitimately arrive over http, but a public sibling must never be
   * handed a downgraded scheme.
   */
  private async validateEdgeSsoTarget(redirect: string | undefined): Promise<URL | null> {
    if (!redirect) {
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
    if (url.protocol === 'http:') {
      const { localDomain } = this.config.getConfig();
      const host = url.hostname.toLowerCase();
      if (!localDomain || localDomain === 'example.com' || !host.endsWith(`.${localDomain.toLowerCase()}`)) {
        return null;
      }
    }
    const appUrn = await this.forwardAuthSecrets.resolveAppUrnForHost(url.hostname);
    return appUrn ? url : null;
  }

  @Get('/traefik')
  async traefik(@Req() req: Request, @Res() res: Response) {
    const forwardedHost = this.normalizeForwardedHost(req.headers['x-forwarded-host']);
    const uri = (req.headers['x-forwarded-uri'] as string | undefined) || '/';
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) || 'http';

    if (req.user) {
      // A ticket that reaches an already-authenticated request was never consumed (the LAN
      // domain cookie short-circuited the exchange). Strip it with one extra redirect so the
      // credential-bearing URL never reaches the app's logs or stays in the address bar.
      if (forwardedHost && uri.includes(`${EDGE_SSO_TICKET_PARAM}=`)) {
        return res.status(302).redirect(`${proto}://${req.headers['x-forwarded-host']}${this.cleanForwardedUri(uri)}`);
      }

      // Sign the identity header so a consumer (e.g. CI-Server, ci-import-tools) can
      // verify it was issued by the Hub and not forged by another container on
      // ci_os_hub_network. The signing secret is PER TARGET APP (CI-Engineering#74):
      // the resolver maps X-Forwarded-Host to the destination app and signs with the
      // secret that app's env actually holds, so one app can never forge an identity
      // header a sibling accepts. Unknown hosts fall back to the Hub-global secret.
      const resolved = await this.forwardAuthSecrets.resolveForHost(req.headers['x-forwarded-host']);
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

    this.logger.debug('Unauthenticated Traefik forward auth request', { uri, proto, host: forwardedHost });

    // Edge-SSO ticket consume (CI-Engineering#77). The Hub and an app on PUBLIC hostnames are
    // cookie-scope siblings, so a Hub login can never plant a cookie the app host sees. Instead
    // /edge-sso redirects back here carrying a single-use ticket, and — because Traefik returns a
    // forward-auth non-2xx response to the browser verbatim, Set-Cookie included — this exchange
    // plants the session cookie scoped to the APP host, then retries the clean URL, which now
    // authenticates. Every failure mode falls through to the login redirect below (which mints a
    // fresh ticket): the flow can loop back to login, but never dead-ends.
    const ticket = this.extractEdgeSsoTicket(uri);
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
        try {
          ({ sessionId, targetHost } = JSON.parse(cached) as { sessionId: string; targetHost: string });
        } catch {
          // fall through to the login redirect
        }
        // Host binding: a ticket minted for one app must not plant a cookie on a sibling. The
        // session must still resolve — a ticket outliving its session plants nothing.
        if (sessionId && targetHost === forwardedHost && this.sessionManager.resolveSessionUserId(sessionId)) {
          await this.setSessionCookie(res, sessionId, req);
          return res.status(302).redirect(`${proto}://${req.headers['x-forwarded-host']}${this.cleanForwardedUri(uri)}`);
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
    const cleanUri = this.cleanForwardedUri(uri);
    const viaTunnel = Boolean(req.headers['cf-ray']);
    const publicHub = viaTunnel ? await this.resolvePublicHub() : null;
    const publicAppHost = publicHub ? await this.forwardAuthSecrets.resolvePublicHostForHost(forwardedHost) : null;

    let hubOrigin: string;
    let target: string;
    if (publicHub && publicAppHost) {
      hubOrigin = publicHub.origin;
      target = `https://${publicAppHost}${cleanUri}`;
    } else {
      const rootDomain = forwardedHost.split('.').slice(1).join('.');
      hubOrigin = `${proto}://${rootDomain}`;
      target = `${proto}://${forwardedHost}${cleanUri}`;
    }

    const ssoUrl = new URL('/api/auth/edge-sso', hubOrigin);
    ssoUrl.searchParams.set('redirect', target);

    this.logger.debug('Redirecting to edge SSO', { ssoUrl: ssoUrl.toString(), target, viaTunnel });

    return res.status(302).redirect(ssoUrl.toString());
  }

  private extractEdgeSsoTicket(uri: string): string | null {
    try {
      const url = new URL(uri, 'http://placeholder');
      return url.searchParams.get(EDGE_SSO_TICKET_PARAM);
    } catch {
      return null;
    }
  }

  /**
   * Edge-SSO mint (CI-Engineering#77) — the Hub-origin half of the exchange consumed in
   * `/traefik` above. Reached by the redirect there; sends the visitor through the normal Hub
   * login when unauthenticated (`redirect_url` loops back HERE, which requires the login page to
   * accept a same-origin absolute URL), and once a session exists mints a single-use, 60s ticket
   * bound to the target app's hostname and bounces the browser back to the app carrying it.
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
    const appLabel = target.hostname.split('.')[0] ?? '';

    const sessionId = req.user ? req.cookies[SESSION_COOKIE_NAME] || req.get('x-ci-hub-session') : undefined;
    if (!sessionId) {
      // Not logged in on this origin (or Bearer-authed, which has no session to hand off): run
      // the normal login flow and come back here. The redirect_url must be ABSOLUTE — the portal
      // OIDC callback validates it as same-origin-absolute, and the login page accepts it.
      const selfUrl = new URL('/api/auth/edge-sso', resolveRequestOriginFallback(req));
      selfUrl.searchParams.set('redirect', target.toString());
      const loginUrl = new URL('/login', resolveRequestOriginFallback(req));
      loginUrl.searchParams.set('redirect_url', selfUrl.toString());
      loginUrl.searchParams.set('app', appLabel);
      return res.status(302).redirect(loginUrl.toString());
    }

    // Loop guard: a browser that refuses the planted cookie would bounce app → here → app
    // forever, each pass minting a fresh ticket. Cap the mint rate per (session, app host) and
    // break the loop with an explanation instead of a redirect.
    const counterKey = `${EDGE_SSO_COUNTER_PREFIX}${sessionId}:${target.hostname.toLowerCase()}`;
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
    this.cache.set(counterKey, String(mints + 1), 60);

    const ticket = crypto.randomUUID();
    // The ticket is the only value that travels in a URL; the session it resolves to stays
    // server-side, bound to the one hostname the consume side will accept it for.
    this.cache.set(`${EDGE_SSO_CACHE_PREFIX}${ticket}`, JSON.stringify({ sessionId, targetHost: target.hostname.toLowerCase() }), 60);

    target.searchParams.set(EDGE_SSO_TICKET_PARAM, ticket);
    return res.status(302).redirect(target.toString());
  }
}
