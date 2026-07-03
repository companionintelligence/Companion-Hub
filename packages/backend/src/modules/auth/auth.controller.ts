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
import { UserRepository } from '@/modules/user/user.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { SessionManager } from './session.manager';
import {
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

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly cache: CacheService,
    private readonly userRepository: UserRepository,
    private readonly sessionManager: SessionManager,
    private readonly registrationService: RegistrationService,
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

  @Get('/traefik')
  async traefik(@Req() req: Request, @Res() res: Response) {
    if (req.user) {
      this.logger.debug('User authenticated for Traefik forward auth', { username: req.user.username });

      // Sign the identity header so a consumer (e.g. CI-Server) can verify it was
      // issued by the Hub and not forged by another container on ci_os_hub_network.
      // See CI-Engineering/architecture/subsystems/security-trust-and-ops.md (gap #5).
      const signed = buildSignedForwardAuthHeaders(this.config.get('forwardAuthSecret'), req.user.username);
      for (const [header, value] of Object.entries(signed)) {
        res.setHeader(header, value);
      }

      return res.status(200).send();
    }

    const uri = req.headers['x-forwarded-uri'] as string;
    const proto = req.headers['x-forwarded-proto'] as string;
    const host = req.headers['x-forwarded-host'] as string;

    this.logger.debug('Unauthenticated Traefik forward auth request', { uri, proto, host });

    const subdomains = host.split('.');
    const app = subdomains[0] ?? '';
    const rootDomain = subdomains.slice(1).join('.');

    const redirectUrl = new URL(uri, `${proto}://${host}`);

    const loginUrl = new URL('/login', `${proto}://${rootDomain}`);
    loginUrl.searchParams.set('redirect_url', redirectUrl.toString());
    loginUrl.searchParams.set('app', app);

    this.logger.debug('Redirecting to login', { loginUrl: loginUrl.toString(), redirectUrl: redirectUrl.toString(), app });

    return res.status(302).redirect(loginUrl.toString());
  }
}
