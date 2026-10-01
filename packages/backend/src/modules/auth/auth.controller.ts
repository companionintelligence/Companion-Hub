import crypto from 'node:crypto';
import net from 'node:net';
import { APP_SESSION_COOKIE_NAME, SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_NAME } from '@/common/constants';
import { buildHubPublicOrigin, resolveHubLocalDomainRoot, resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { hashEmailForLog } from '@/common/helpers/log-privacy';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { UserDto } from '@/modules/user/dto/user.dto';
import type { AppUrn } from '@ci-hub/common/types';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import { AuthService, type PairedOrgMembership } from './auth.service';
import { buildSignedForwardAuthHeaders } from './utils/forward-auth-signing';
import { normalizeForwardedHost, rawForwardedHost } from './utils/forward-auth-host';
import { ForwardAuthIdentityResolver } from './forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from './forward-auth-secret.resolver';
import { BearerOrgMembershipCache } from './bearer-org-membership.cache';
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
  HubClaimBody,
  HubClaimDto,
  HubClaimStatusDto,
  HubOperatorsDto,
  LoginBody,
  LoginDto,
  PasswordResetCompleteBody,
  PasswordResetCompleteDto,
  PasswordResetRequestBody,
  PasswordResetRequestDto,
  PasswordResetVerifyResponseDto,
  PortalDesktopExchangeDto,
  PortalDesktopHandoffStatusDto,
  PortalSessionHintDto,
  RegisterBody,
  RegisterDto,
  ResetPasswordBody,
  ResetPasswordDto,
  SessionRefreshDto,
  SetupTotpBody,
  VerifyTotpBody,
} from './dto/auth.dto';
import { HUB_FAVICON_LINK_TAG, HUB_FAVICON_PNG } from './hub-favicon';
import { ApiExcludeEndpoint, ApiResponse } from '@nestjs/swagger';
import {
  buildPortalDesktopDeepLink,
  buildPortalDesktopHandoffHtml,
  buildPortalSsoErrorRedirectUrl,
  PORTAL_DESKTOP_CLAIMED_TTL_SECONDS,
  PORTAL_DESKTOP_HANDOFF_TTL_SECONDS,
  PORTAL_DESKTOP_PRESENCE_CACHE_KEY,
  PORTAL_DESKTOP_PRESENCE_TTL_SECONDS,
  portalDesktopClaimedKey,
  portalDesktopPendingKey,
  resolvePortalDesktopHandoffState,
  shouldHandoffPortalLoginToDesktop,
  exchangePortalAuthorizationCode,
  fetchPortalSessionEmail,
  probePortalReachable,
  type PortalDesktopExchange,
  type PortalSsoErrorCode,
  type PortalSsoState,
  resolveHubRequestOrigin,
  resolvePortalCallbackUrl,
  resolveRequestOriginFallback,
  resolveSameOriginRedirectUrl,
  resolveTrustedReturnOrigin,
  toDesktopRedirectPath,
  parseDesktopChannel,
  type DesktopChannel,
} from './portal-sso';
import { extractBearerToken, portalClaimsIdentity, verifyPortalIdToken } from './portal-token';
import { loadSessionUser, refuseRevokedSessionUser, sessionIdsFromRequest } from './auth.middleware';
import { isMemoryProviderApp } from '../memory-connect/memory-provider.predicate';

/** Query param carrying the single-use edge-SSO ticket between the Hub and an app host (#77). */
const EDGE_SSO_TICKET_PARAM = 'cihub_sso';
const EDGE_SSO_CACHE_PREFIX = 'edge_sso:';
const EDGE_SSO_COUNTER_PREFIX = 'edge_sso_mints:';
/** Caps the redirect loop for browsers that refuse the planted cookie. */
const EDGE_SSO_MAX_MINTS_PER_MINUTE = 3;
/** Width of the loop-guard window, in seconds. Fixed, not sliding — see the mint counter below. */
const EDGE_SSO_MINT_WINDOW_SECONDS = 60;
/** One redirect hop needs little time, so a short lifetime limits replay exposure. */
const EDGE_SSO_TICKET_TTL_SECONDS = 60;

/** A minted edge-SSO ticket, cached under `EDGE_SSO_CACHE_PREFIX`. The mint writes it; the consume and logout read it. */
interface EdgeSsoTicket {
  sessionId: string;
  targetHost: string;
  targetUrl: string;
  /** The app the target hostname resolved to at mint. */
  appUrn: AppUrn;
}

/**
 * Paths Companion Memory authenticates itself, so edge auth lets them through
 * without a Hub session: Phone Memory returns to a Capacitor webview without
 * the Hub cookie, and its login exchange and API routes must reach Nest for
 * app-level authentication. Browser HTML remains on cookie SSO.
 *
 * ONLY for the official Memory install — see `isMemoryProviderHost`. Every
 * other edge-authenticated app relies on the Hub to authenticate for it, and
 * these paths mean nothing to them.
 */
const FORWARD_AUTH_APP_PUBLIC_PREFIXES = ['/api/authenticate', '/api/health', '/api/keys'] as const;

function isForwardAuthAppPublicPath(uri: string): boolean {
  const path = (uri.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  return FORWARD_AUTH_APP_PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function translatableErrorKey(error: unknown): string {
  if (!(error instanceof TranslatableError)) {
    return '';
  }
  const response = error.getResponse();
  if (typeof response === 'object' && response && 'message' in response) {
    return String((response as { message: unknown }).message);
  }
  return typeof error.message === 'string' ? error.message : '';
}

/**
 * Whether the request carries an `x-api-key` header at all. The VALUE is not
 * checked here — it is Memory's key, and Memory verifies it — which is exactly
 * why this exemption is scoped to the official Memory install by
 * `isMemoryProviderHost`. Applied to every edge-authenticated app, as it once
 * was, any non-empty header was an unauthenticated pass into apps that never
 * look at it (2026-09-24 audit).
 */
function requestHasApiKey(req: Request): boolean {
  const raw = req.headers['x-api-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0;
}

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
    private readonly bearerOrgMembership: BearerOrgMembershipCache,
    private readonly sessionUserCache: SessionUserCache,
    private readonly forwardAuthIdentities: ForwardAuthIdentityResolver,
  ) {}

  private sessionCookieOptions(req: Request) {
    // Normalize ports and repeated headers before `getCookieDomain` applies its FQDN check.
    const host = normalizeForwardedHost(req.headers['x-forwarded-host']);
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    const domain = this.authService.getCookieDomain(host);
    const secure = proto === 'https';
    return { host, proto, domain, secure };
  }

  private async setSessionCookie(res: Response, sessionId: string, req: Request) {
    const options = this.sessionCookieOptions(req);
    this.logger.debug('Setting session cookie', { host: options.host, domain: options.domain, proto: options.proto, secure: options.secure });

    if (this.config.get('userSettings').experimental.insecureCookie) {
      this.logger.warn('WARNING: Using insecure cookies. This is not recommended for production environments.');
      res.cookie(SESSION_COOKIE_NAME, sessionId, { httpOnly: true, secure: false, sameSite: 'lax', maxAge: SESSION_COOKIE_MAX_AGE });
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE,
      domain: options.domain,
    });
  }

  /** Must pass the same Domain/Secure flags as Set-Cookie or the browser keeps the stale session. */
  private async clearSessionCookie(res: Response, req: Request) {
    const options = this.sessionCookieOptions(req);
    if (this.config.get('userSettings').experimental.insecureCookie) {
      res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: false, sameSite: 'lax' });
      return;
    }
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'lax',
      domain: options.domain,
    });
  }

  /**
   * Desktop handoff needs the browser-reachable Hub origin so its cookie covers Hub routes.
   * The organization slug limits sibling redirect targets to this appliance.
   */
  private async resolvePublicHub(): Promise<{ origin: string; orgSlug: string } | null> {
    // A transient registration query failure must not turn every forward-auth request into a hard outage.
    // Callers already handle a missing result through LAN or login fallbacks.
    let org: Awaited<ReturnType<DeviceRegistrationRepository['getFirstDeviceRegistration']>>;
    try {
      org = await this.deviceRegistration.getFirstDeviceRegistration();
    } catch (error) {
      this.logger.warn('Failed to load device registration while resolving public Hub origin', error);
      return null;
    }

    // Share provisioning rules with memory-connect through the origin helper.
    const origin = buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain: this.publicDomainRoot() });

    if (!origin) {
      return null;
    }

    return { origin, orgSlug: org?.slug ?? '' };
  }

  /**
   * Match exposure-sync precedence so authentication redirects use the domain the tunnel published.
   * An operator override outranks `DOMAIN` for the life of the process; see the helper for why it
   * does not survive a restart.
   */
  private publicDomainRoot(): string {
    return resolveHubPublicDomainRoot(this.config.getConfig());
  }

  /** The local root the appliance's LAN hostnames are built with — same precedence as above. */
  private localDomainRoot(): string {
    return resolveHubLocalDomainRoot(this.config.getConfig());
  }

  /**
   * Restrict handoff redirects to the Hub or HTTPS sibling hosts under this appliance's domain and organization label.
   * The organization boundary excludes co-tenant hosts and closes the open redirect in raw `next`.
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

    // Use published-domain precedence so operator-configured sibling hosts remain valid.
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
        // Require an app label before the organization suffix.
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

    await this.replacePresentedSessions(req, sessionId);
    await this.setSessionCookie(res, sessionId, req);

    // WebView2 over HTTP cannot rely on cross-origin cookies, so the desktop app also receives the ID.
    return LoginDto.parse({ success: true, sessionId }, { reportOnly: true });
  }

  @Post('/verify-totp')
  @ApiResponse({ type: LoginDto })
  async verifyTotp(@Body() body: VerifyTotpBody, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    const { sessionId } = await this.authService.verifyTotp(body);

    await this.replacePresentedSessions(req, sessionId);
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

  /**
   * The Hub's own state, for the one caller that can do something about it.
   *
   * Behind the host-local key rather than public: "this appliance has nobody on it" is exactly the
   * sentence you would want before deciding to attack one, and the only caller who needs it —
   * `cihub doctor` on the box itself — already holds the key.
   */
  @Get('/hub/claim')
  @ApiResponse({ type: HubClaimStatusDto })
  async hubClaimStatus(@Req() req: Request) {
    this.requireDeviceKeyPrincipal(req);
    const [operators, registration] = await Promise.all([this.userRepository.getOperators(), this.deviceRegistration.getFirstDeviceRegistration()]);

    return HubClaimStatusDto.parse(
      {
        claimed: operators.length > 0,
        operators: operators.length,
        registered: Boolean(registration?.id) && Boolean(this.config.get('ciHubOrganizationId')),
      },
      { reportOnly: true },
    );
  }

  /**
   * Create the first operator on a registered-but-unclaimed Hub, without a browser.
   *
   * Until now the ONLY thing that could write that row was an interactive Portal login landing on
   * `/api/auth/portal/callback` — `cihub register` writes the device key and the organization id
   * and stops there, and `POST /register` cannot finish headlessly because Portal answers it with
   * `requiresEmailVerification`. So every headless appliance came up registered, keyed, and unable
   * to authenticate its own operator API. That is the gap this closes.
   *
   * It is deliberately not a new way IN. Three things gate it, and each is already true of the
   * browser path it substitutes for:
   *
   *   1. The host-local device key. It lives in `<data-dir>/state/settings.json`, so presenting it
   *      means the caller can already read that file — the same access `cihub` itself needs, and
   *      strictly less than the root shell that could write the `user` table directly.
   *   2. This Hub must be paired. Pairing is what proved org membership in the first place; a Hub
   *      that has not done it has no organization for an operator to belong to.
   *   3. There must be no operator yet. First-operator bootstrap is the ONE admission that skips
   *      the Portal membership check (see `admitHubPerson`), so it must happen at most once —
   *      after that, additional people go through Portal and get checked.
   *
   * The row itself is written by `admitHubPerson`, not here: the rules about who may become an
   * operator on this appliance live in one place, and a second creation path would be a second
   * place for them to drift.
   *
   * Not `@UseGuards(AuthGuard)` on purpose — on an unclaimed Hub that guard's answer is the 409
   * this route exists to clear.
   */
  @Post('/hub/claim')
  @ApiResponse({ type: HubClaimDto })
  async claimHub(@Body() body: HubClaimBody, @Req() req: Request) {
    this.requireDeviceKeyPrincipal(req);

    const registration = await this.deviceRegistration.getFirstDeviceRegistration();
    if (!registration?.id || !this.config.get('ciHubOrganizationId')) {
      throw new TranslatableError('AUTH_ERROR_HUB_NOT_REGISTERED', {}, HttpStatus.CONFLICT);
    }

    // Checked here as well as inside `admitHubPerson` so the refusal names the real reason. Left to
    // the service, a second claim for a different address surfaces as "user not found", which reads
    // as a lookup failure rather than "this Hub is already somebody's".
    const operators = await this.userRepository.getOperators();
    if (operators.length > 0) {
      throw new TranslatableError('AUTH_ERROR_HUB_ALREADY_CLAIMED', {}, HttpStatus.CONFLICT);
    }

    // Empty issuer: `admitHubPerson` fills in this Hub's public Portal base URL. No subject, so it
    // takes the local-bootstrap branch — the federated (iss, sub) link is written later, by the
    // operator's first real Portal sign-in, which is the only thing that can prove a subject.
    //
    // That fill-in throws 503 when `CI_CLOUD_URL` is unset, which is left alone deliberately: a Hub
    // that got past the registration gate above and still has no Portal URL is genuinely broken,
    // and "CI_CLOUD_URL is not configured" is a better answer than a claim that half-works.
    const user = await this.authService.admitHubPerson({ issuer: '', subject: null, email: body.email, emailVerified: false });

    this.logger.info(`Hub claimed headlessly by device key for ${hashEmailForLog(user.username)}`);

    return HubClaimDto.parse({ claimed: true, username: user.username }, { reportOnly: true });
  }

  /**
   * The host-local key, and nothing else, admits a caller to the claim routes.
   *
   * A session would be circular (there is no operator to hold one); the CLI JWT is not accepted
   * because it is minted by the backend for its own callers rather than presented by an operator
   * who can read the state file; and Portal's push key (`portal-device`) is Portal, not someone on
   * the box. The host-local key is written into `state/settings.json` at boot and read by `cihub`
   * there, so presenting it is proof of exactly that access. (It replaced the Portal DEVICE key in
   * this role: that key is also held by first-party Memory, which must not be able to claim a Hub.)
   */
  private requireDeviceKeyPrincipal(req: Request) {
    if (req.hubPrincipal !== 'host-local') {
      throw new TranslatableError('AUTH_ERROR_HUB_CLAIM_REQUIRES_DEVICE_KEY', {}, HttpStatus.UNAUTHORIZED);
    }
  }

  @Post('/logout')
  async logout(@Res() res: Response, @Req() req: Request) {
    await this.clearSessionCookie(res, req);
    // Cookie and header can name different sessions after a login race. Destroy every
    // id the client presented so a stale cookie cannot leave the live header session
    // (or vice versa) authenticated after "log out".
    const sessionIds = new Set(sessionIdsFromRequest(req));
    if (req.hubSessionId) {
      sessionIds.add(req.hubSessionId);
    }
    this.invalidateEdgeSsoForSessions(sessionIds);
    for (const sessionId of sessionIds) {
      await this.authService.logout(sessionId);
    }

    return res.status(204).send();
  }

  /** A new login must kill every other id this browser presented so a stale cookie cannot win. */
  private async replacePresentedSessions(req: Request, keepSessionId: string) {
    for (const presented of sessionIdsFromRequest(req)) {
      if (presented !== keepSessionId) {
        await this.sessionManager.deleteSession(presented);
      }
    }
    this.invalidateEdgeSsoForSessions([...sessionIdsFromRequest(req), keepSessionId].filter((id) => id !== keepSessionId));
  }

  /** App-host tickets stay valid after Hub logout unless we burn the ones bound to this session. */
  private invalidateEdgeSsoForSessions(sessionIds: Iterable<string>) {
    const wanted = new Set([...sessionIds].filter(Boolean));
    if (wanted.size === 0) {
      return;
    }

    for (const entry of this.cache.getByPrefix(EDGE_SSO_CACHE_PREFIX) ?? []) {
      try {
        const parsed = JSON.parse(entry.val) as Partial<EdgeSsoTicket>;
        if (parsed.sessionId && wanted.has(parsed.sessionId)) {
          this.cache.del(entry.key);
        }
      } catch {
        // Unreadable ticket — leave it; TTL will drop it.
      }
    }

    for (const sessionId of wanted) {
      for (const entry of this.cache.getByPrefix(`${EDGE_SSO_COUNTER_PREFIX}${sessionId}:`) ?? []) {
        this.cache.del(entry.key);
      }
    }
  }

  /** Desktop clients refresh before expiry because they persist the returned session ID outside browser cookies. */
  @Post('/session/refresh')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: SessionRefreshDto })
  async refreshSession(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const sessionId = req.hubSessionId ?? req.cookies[SESSION_COOKIE_NAME] ?? req.get('x-ci-hub-session');
    if (!sessionId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', undefined, HttpStatus.UNAUTHORIZED);
    }

    const nextSessionId = await this.authService.refreshSession(sessionId);
    await this.setSessionCookie(res, nextSessionId, req);

    return SessionRefreshDto.parse({ sessionId: nextSessionId, issuedAt: Date.now() }, { reportOnly: true });
  }

  /**
   * The desktop's header session cannot cross into a system-browser navigation, so a short-lived ticket delegates a browser session without a second login.
   * A missing public Hub origin returns no handoff URL so the caller can fall back to a plain external open.
   */
  @Post('/browser-handoff/mint')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: BrowserHandoffMintDto })
  async mintBrowserHandoff(@Body() body: BrowserHandoffMintBody, @Req() req: Request) {
    const sessionId = req.hubSessionId ?? req.cookies[SESSION_COOKIE_NAME] ?? req.get('x-ci-hub-session');
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
    // Keeping the target server-side prevents the consume URL from carrying an open-redirect target.
    this.cache.set(`browser_handoff:${ticket}`, JSON.stringify({ sessionId, next: body.next }), 60);

    return BrowserHandoffMintDto.parse({ url: `${hub.origin}/api/auth/browser-handoff?ticket=${encodeURIComponent(ticket)}` }, { reportOnly: true });
  }

  /**
   * The single-use ticket acts as the credential for a delegated browser session, so missing or stale tickets fail without setting a cookie.
   * Only fresh user-initiated navigation may consume it, preventing login CSRF from page-initiated requests.
   * Rejections stay silent because this unauthenticated endpoint would otherwise amplify log floods.
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
      // Avoid a synchronous store write for every unauthenticated ticket miss.
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

    // Revalidate in case registration changed after the ticket was minted.
    const hub = await this.resolvePublicHub();
    if (!sessionId || !next || !hub || !this.isSafeHandoffNext(next, hub.origin, hub.orgSlug)) {
      return res.redirect('/');
    }

    // Give the browser its own session because browser rotation deletes the replaced ID and would log out the desktop (#944).
    // Independent session lifecycles prevent the two contexts from invalidating each other.
    const userId = this.sessionManager.resolveSessionUserId(sessionId);
    if (userId === null) {
      // Do not plant a session that died during the ticket window.
      return res.redirect('/');
    }

    // Reuse a live same-user session to avoid leaving week-long sessions behind.
    // `touchSession` rejects rotation-grace IDs and extends a session that must survive the round trip.
    const existingSessionId = req.cookies[SESSION_COOKIE_NAME];
    const reusableSessionId =
      typeof existingSessionId === 'string' && existingSessionId && this.sessionManager.resolveSessionUserId(existingSessionId) === userId
        ? existingSessionId
        : null;

    if (reusableSessionId && this.sessionManager.touchSession(reusableSessionId)) {
      // Reissue the cookie because extending only server expiry can still let the browser cookie die mid-flow (#944).
      await this.setSessionCookie(res, reusableSessionId, req);
      return res.redirect(next);
    }

    const browserSessionId = await this.sessionManager.createSession(userId);
    await this.setSessionCookie(res, browserSessionId, req);
    return res.redirect(next);
  }

  /** Desktop login returns through its deep link, while browser login returns to the initiating Hub origin. */
  @Get('/portal/start')
  async startPortalLogin(
    @Req() req: Request,
    @Res() res: Response,
    @Query('redirect_url') redirectUrl?: string,
    @Query('desktop') desktop?: string,
    @Query('desktop_channel') desktopChannel?: string,
  ) {
    const isDesktop = desktop === '1' || desktop === 'true' || this.cache.get(PORTAL_DESKTOP_PRESENCE_CACHE_KEY) === '1';
    // Declared by the client. Absent reads as 'packaged' — see
    // resolvePortalDesktopDeepLinkScheme for why that is the safe default.
    const channel = parseDesktopChannel(desktopChannel);
    const fallbackOrigin = resolveRequestOriginFallback(req);
    const redirectStartError = (errorCode: PortalSsoErrorCode, hubOrigin?: string | null) =>
      res.redirect(
        buildPortalSsoErrorRedirectUrl({
          hubOrigin: hubOrigin ?? null,
          desktop: isDesktop,
          desktopChannel: channel,
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
    // A short callback window limits stale PKCE state.
    const portalState: PortalSsoState = { codeVerifier, redirectUrl: redirectUrl || null, hubOrigin, desktop: isDesktop, desktopChannel: channel };
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
    // Restored from the PKCE state below; 'packaged' until we know otherwise.
    let desktopChannel: DesktopChannel = 'packaged';
    const redirectError = (hubOrigin: string | null, errorCode: PortalSsoErrorCode) => {
      // Returning the Express response under passthrough would serialize its circular socket and fail.
      res.redirect(
        buildPortalSsoErrorRedirectUrl({
          hubOrigin,
          desktop,
          desktopChannel,
          errorCode,
          fallbackOrigin,
        }),
      );
    };

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
        desktopChannel = parsed.desktopChannel ?? 'packaged';
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
      let operator: Awaited<ReturnType<AuthService['admitHubPerson']>>;

      try {
        operator = await this.authService.admitHubPerson({
          issuer: exchange.issuer,
          subject: exchange.subject,
          email,
          emailVerified: exchange.emailVerified,
        });
      } catch (error) {
        const code = translatableErrorKey(error);
        if (code === 'AUTH_ERROR_NOT_ORG_MEMBER') {
          this.logger.warn('Portal login blocked: subject is not a member of this Hub org', {
            portalEmailHash: hashEmailForLog(email),
          });
          return redirectError(hubOrigin, 'not_org_member');
        }
        // Distinct from the above on purpose: nothing is wrong with this account, we just could not
        // reach Portal to check. Telling them to ask for an invite would send them after a problem
        // they do not have.
        if (code === 'AUTH_ERROR_ORG_CHECK_UNAVAILABLE') {
          this.logger.warn('Portal login deferred: could not reach Portal to confirm org membership', {
            portalEmailHash: hashEmailForLog(email),
          });
          return redirectError(hubOrigin, 'org_check_unavailable');
        }
        if (code === 'AUTH_ERROR_USER_NOT_FOUND' || code === 'AUTH_ERROR_INVALID_CREDENTIALS') {
          this.logger.warn('Portal login blocked: no Hub person for this identity', {
            portalEmailHash: hashEmailForLog(email),
          });
          return redirectError(hubOrigin, 'account_mismatch');
        }
        this.logger.warn('Portal OAuth callback failed to admit Hub person', { error });
        return redirectError(hubOrigin, 'callback_error');
      }

      const sessionId = await this.sessionManager.createSession(operator.id);
      await this.replacePresentedSessions(req, sessionId);
      await this.setSessionCookie(res, sessionId, req);

      const handoffToDesktop = shouldHandoffPortalLoginToDesktop({
        desktop,
        hubOrigin,
        desktopAppPresent: this.cache.get(PORTAL_DESKTOP_PRESENCE_CACHE_KEY) === '1',
      });

      if (handoffToDesktop) {
        const desktopToken = crypto.randomUUID();
        const exchangePayload: PortalDesktopExchange = {
          sessionId,
          redirectPath: toDesktopRedirectPath(redirectUrl, hubOrigin),
          userId: operator.id,
        };
        this.cache.set(portalDesktopPendingKey(desktopToken), JSON.stringify(exchangePayload), PORTAL_DESKTOP_HANDOFF_TTL_SECONDS);
        const deepLink = buildPortalDesktopDeepLink(desktopToken, desktopChannel);
        this.logger.info('Portal desktop handoff issued one-time token', { hubOrigin, redirectPath: exchangePayload.redirectPath });
        // Some browsers drop redirects to the desktop scheme, so serve a navigation page.
        // Do not return the Express response because passthrough would serialize it.
        res.status(200);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(
          buildPortalDesktopHandoffHtml({
            deepLink,
            /*
             * The cookie went out with this same response, so this link is the
             * whole of "carry on in the browser" — no token, no second sign-in.
             * It is the same destination the app is being sent to.
             */
            continueHref: exchangePayload.redirectPath,
            statusHref: `/api/auth/portal/desktop-handoff-status?token=${encodeURIComponent(desktopToken)}`,
          }),
        );
        return;
      }

      // Redirect back to the requested URL if it's same-origin; otherwise go home.
      const safeRedirect = resolveSameOriginRedirectUrl(redirectUrl, hubOrigin);
      if (safeRedirect) {
        res.redirect(safeRedirect);
        return;
      }

      res.redirect(new URL('/home', hubOrigin).toString());
      return;
    } catch (error) {
      this.logger.error('Portal OAuth callback crashed', error);
      return redirectError(null, 'callback_error');
    }
  }

  @Get('/portal/session-hint')
  @ApiResponse({ type: PortalSessionHintDto })
  async portalSessionHint(@Req() req: Request, @Query('desktop') desktop?: string) {
    if (desktop === '1' || desktop === 'true') {
      this.cache.set(PORTAL_DESKTOP_PRESENCE_CACHE_KEY, '1', PORTAL_DESKTOP_PRESENCE_TTL_SECONDS);
    }
    const portalBaseUrl = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '') || null;

    if (!portalBaseUrl) {
      return PortalSessionHintDto.parse({ email: null, portalBaseUrl: null, source: null, portalReachable: false }, { reportOnly: true });
    }

    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    const [portalEmail, portalReachable] = await Promise.all([
      fetchPortalSessionEmail({
        publicPortalBaseUrl: portalBaseUrl,
        cookieHeader,
      }),
      probePortalReachable(portalBaseUrl),
    ]);

    if (portalEmail) {
      return PortalSessionHintDto.parse(
        {
          email: portalEmail,
          portalBaseUrl,
          source: 'portal_session',
          portalReachable,
        },
        { reportOnly: true },
      );
    }

    const sessionEmail = typeof req.user?.username === 'string' ? req.user.username.trim() : '';
    if (sessionEmail) {
      return PortalSessionHintDto.parse(
        {
          email: sessionEmail,
          portalBaseUrl,
          source: 'hub_user',
          portalReachable,
        },
        { reportOnly: true },
      );
    }

    const operator = await this.userRepository.getFirstOperator();
    if (operator?.username?.trim()) {
      return PortalSessionHintDto.parse(
        {
          email: operator.username.trim(),
          portalBaseUrl,
          source: 'hub_operator',
          portalReachable,
        },
        { reportOnly: true },
      );
    }

    return PortalSessionHintDto.parse({ email: null, portalBaseUrl, source: null, portalReachable }, { reportOnly: true });
  }

  @Get('/operators')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: HubOperatorsDto })
  async listOperators() {
    const operators = await this.authService.listOperators();
    return HubOperatorsDto.parse(
      {
        operators: operators.map((operator) => ({
          id: operator.id,
          username: operator.username,
          orgRole: operator.orgRole === 'owner' || operator.orgRole === 'admin' || operator.orgRole === 'member' ? operator.orgRole : null,
          accessStatus: operator.accessStatus === 'revoked' ? 'revoked' : 'active',
          membershipCheckedAt: operator.membershipCheckedAt ?? null,
          localPasswordSet: Boolean(operator.localPasswordSetAt),
        })),
      },
      { reportOnly: true },
    );
  }

  @Get('/portal/desktop-exchange')
  @ApiResponse({ type: PortalDesktopExchangeDto })
  async exchangePortalDesktopLogin(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Query('token') token?: string) {
    if (!token) {
      throw new BadRequestException('Missing desktop exchange token');
    }

    const cacheKey = portalDesktopPendingKey(token);
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      throw new BadRequestException('Invalid or expired desktop exchange token');
    }

    let parsed: PortalDesktopExchange;
    try {
      parsed = JSON.parse(cached) as PortalDesktopExchange;
    } catch {
      this.cache.del(cacheKey);
      throw new BadRequestException('Malformed desktop exchange payload');
    }

    let sessionId = parsed.sessionId;
    if (!this.sessionManager.resolveSessionUserId(sessionId)) {
      if (!parsed.userId) {
        this.cache.del(cacheKey);
        throw new BadRequestException('Invalid or expired desktop exchange token');
      }
      sessionId = await this.sessionManager.createSession(parsed.userId);
    }

    /*
     * ⚠ MARK BEFORE DELETING. The handoff page left open in the browser polls
     * for this marker to stop spinning. Deleting the token first would leave a
     * window in which neither key exists, and a poll landing in it would tell
     * the user the sign-in expired at the exact moment it succeeded.
     */
    this.cache.set(portalDesktopClaimedKey(token), '1', PORTAL_DESKTOP_CLAIMED_TTL_SECONDS);
    this.cache.del(cacheKey);
    await this.setSessionCookie(res, sessionId, req);
    this.logger.info('Portal desktop exchange planted a session cookie', { redirectPath: parsed.redirectPath });
    return PortalDesktopExchangeDto.parse({ sessionId, redirectPath: parsed.redirectPath }, { reportOnly: true });
  }

  /**
   * Phone cloud-connect already signed this person in at Portal. The Hub they
   * then pick is the same account, so the second in-app sheet is not a new
   * login: it is this id_token becoming a Hub session.
   *
   * The token is the one `ci-hub` PKCE minted (`aud` includes `ci-hub`). An
   * unverified email is refused the same way the browser callback refuses it.
   */
  @Post('/portal/mobile-session')
  @ApiResponse({ type: PortalDesktopExchangeDto })
  async establishPortalMobileSession(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const bearer = extractBearerToken(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
    const portalBase = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '');
    const claims = bearer && portalBase ? await verifyPortalIdToken(bearer, { publicCiCloudUrl: portalBase }) : null;
    if (!claims?.email || claims.emailVerified !== true) {
      throw new UnauthorizedException('Portal sign-in could not be used on this Hub');
    }

    const operator = await this.authService.admitHubPerson({
      issuer: claims.issuer || portalBase,
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
    });
    const sessionId = await this.sessionManager.createSession(operator.id);
    await this.setSessionCookie(res, sessionId, req);
    this.logger.info('Portal mobile session planted from the cloud-connect id_token', {
      portalEmailHash: hashEmailForLog(claims.email),
    });
    return PortalDesktopExchangeDto.parse({ sessionId, redirectPath: '/home' }, { reportOnly: true });
  }

  /**
   * Has the desktop app taken this login yet?
   *
   * Read-only, and the one thing it must never do is consume the token — the
   * app has to be able to spend it after the page has asked about it.
   *
   * Unauthenticated on purpose. The caller is the handoff page, which is served
   * before the frontend exists and on Hubs with no frontend bundle at all, and
   * it already holds the token: presenting an unguessable value back to the
   * issuer proves nothing it did not already know. The answer is one bit about
   * a credential the asker has, never anything about the account behind it.
   */
  @Get('/portal/desktop-handoff-status')
  @ApiResponse({ type: PortalDesktopHandoffStatusDto })
  portalDesktopHandoffStatus(@Query('token') token?: string) {
    if (!token) {
      throw new BadRequestException('Missing desktop exchange token');
    }

    const state = resolvePortalDesktopHandoffState({
      claimed: this.cache.get(portalDesktopClaimedKey(token)) !== undefined,
      pending: this.cache.get(portalDesktopPendingKey(token)) !== undefined,
    });

    return PortalDesktopHandoffStatusDto.parse({ state }, { reportOnly: true });
  }

  /**
   * The tab icon for the pages this controller writes itself — the desktop
   * handoff and the edge-SSO cookie notice. Unauthenticated for the same reason
   * as the status poll above: those pages exist before any session does. See
   * hub-favicon.ts for why it is a URL and not a data URI.
   */
  @Get('/favicon.png')
  @ApiExcludeEndpoint()
  favicon(@Res() res: Response) {
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(HUB_FAVICON_PNG);
  }

  @Patch('/username')
  @UseGuards(AuthGuard)
  async changeUsername(@Body() body: ChangeUsernameBody, @Req() req: Request, @Res() res: Response) {
    const userId = req.user?.id;

    if (!userId) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.authService.changeUsername({ userId, ...body });

    await this.clearSessionCookie(res, req);
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

    await this.clearSessionCookie(res, req);
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
   * Remove every edge-SSO ticket after its consume hop so credentials do not remain in logs, the address bar, or a remint target.
   * Preserve all other query segments byte-for-byte because URLSearchParams re-encoding can corrupt signed or strictly parsed requests.
   */
  private parseForwardedUri(uri: string): { ticket: string | null; cleanUri: string } {
    const queryStart = uri.indexOf('?');
    if (queryStart === -1 || !uri.includes(`${EDGE_SSO_TICKET_PARAM}=`)) {
      return { ticket: null, cleanUri: uri || '/' };
    }

    // Split manually so non-ticket segments retain their original encoding.
    const path = uri.slice(0, queryStart) || '/';
    const segments = uri.slice(queryStart + 1).split('&');
    const kept: string[] = [];
    let ticket: string | null = null;

    for (const segment of segments) {
      const eq = segment.indexOf('=');
      // Exact name matching prevents lookalike parameters from causing a self-redirect.
      if (eq !== -1 && segment.slice(0, eq) === EDGE_SSO_TICKET_PARAM) {
        // Drop duplicates because a stale first ticket would shadow every newly appended ticket.
        // Only the first value is consumed.
        if (ticket === null) {
          const raw = segment.slice(eq + 1);
          try {
            ticket = decodeURIComponent(raw);
          } catch {
            // Preserve malformed input so lookup misses instead of throwing from forward auth.
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
   * The tunnel rewrites remote and LAN hosts identically, so `cf-ray` is the signal that distinguishes them.
   * Both halves of edge SSO must use the same classification.
   */
  private viaCloudflareTunnel(req: Request): boolean {
    return Boolean(req.headers['cf-ray']);
  }

  /**
   * Traefik resolves relative forward-auth locations against the auth server, so redirects must be absolute and use a browser-reachable host.
   * A tunnel caller needs its mapped public host; when none is known, staying put is safer than redirecting to an internal address.
   * Pinning one leading slash prevents a client path from becoming a protocol-relative redirect.
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
   * The resolver host map provides an exact allowlist of installed app routers, including unregistered LAN appliances.
   * HTTP is limited to this appliance's local domain so public siblings cannot be downgraded.
   * Loopback is rejected because local open bypasses ticket SSO under ADR 001 and ADR 002.
   * The app the host resolves to is returned with it: that app is all the consumed ticket will authenticate to.
   */
  private async validateEdgeSsoTarget(redirect: string | undefined): Promise<{ url: URL; appUrn: AppUrn } | null> {
    // Repeated query keys arrive as arrays, which URL would stringify into a corrupted allowed target.
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
    const appUrn = await this.forwardAuthSecrets.resolveAppUrnForHost(url.hostname);
    return appUrn ? { url, appUrn } : null;
  }

  /**
   * Whether a Portal Bearer token's subject may authenticate to THIS Hub's apps (CI-Hub#1333).
   * `AuthService.resolvePairedOrgMembership` is the same appliance-binding check the cookie/SSO
   * login path uses (`admitHubPerson`); this wraps it in a short-lived cache because — unlike a
   * one-time login — the Traefik forward-auth path runs on every machine-client app request, and
   * a Portal round trip per request is both slow and needless traffic to Portal.
   *
   * Three things this must get right, none of which a plain "call it and cache the boolean" does:
   *
   * 1. It fails closed. A missing subject, a refusal, or a lookup that could not be made at all is
   *    "not authorized" — never "let it through because we could not tell."
   * 2. It does not REMEMBER "could not tell". A device-registration read blip or a Portal 5xx would
   *    otherwise be written down as a refusal and lock every machine client out for the full TTL,
   *    turning a one-second wobble into a one-minute outage. Same policy as
   *    `ForwardAuthSecretResolver`: "Do not cache read failures so the next request can recover."
   * 3. It coalesces. The cache only helps AFTER the first answer comes back, so a cold-start burst
   *    from one client would otherwise fan out into one Portal round trip per in-flight request —
   *    exactly the traffic the cache exists to prevent.
   */
  private async isBearerSubjectAuthorizedForThisHub(subject: string, targetHost: string): Promise<boolean> {
    const trimmed = subject?.trim();
    if (!trimmed) {
      return false;
    }

    const remembered = this.bearerOrgMembership.get(trimmed);
    if (remembered !== undefined) {
      return remembered;
    }

    let membership: PairedOrgMembership;
    try {
      membership = await this.bearerOrgMembership.coalesce(trimmed, () => this.authService.resolvePairedOrgMembership(trimmed));
    } catch (error) {
      this.logger.warn(`Traefik forward auth could not resolve Portal org membership: ${error instanceof Error ? error.message : String(error)}`, {
        targetHost,
      });
      return false;
    }

    if (membership === 'unknown') {
      // Deny, but deliberately do not remember it — see (2) above.
      this.logger.warn("Traefik forward auth rejected Portal Bearer token: could not confirm this Hub's paired organization", { targetHost });
      return false;
    }

    const allowed = membership === 'member';
    if (!allowed) {
      // Logged here rather than at the 403 so a client retrying in a loop writes one line per TTL
      // window instead of one per request: the same warning-flood guard the unauthenticated branch
      // of `traefik` already applies to itself.
      this.logger.warn("Traefik forward auth rejected Portal Bearer token: subject is not a member of this Hub's paired organization", {
        subject: trimmed,
        targetHost,
      });
    }
    this.bearerOrgMembership.set(trimmed, allowed);
    return allowed;
  }

  /**
   * The user an app-session cookie authenticates on this forwarded host, or undefined.
   *
   * ⚠ BOUND TO THE APP, NOT THE HOSTNAME. An app answers on several names — platform hostname, LAN
   * origin, custom domain — that all resolve to its one URN, so each of them accepts its session,
   * while a session minted for one app is refused on every other app's host.
   */
  private async resolveAppSessionUser(req: Request, forwardedHost: string): Promise<UserDto | undefined> {
    const appSessionId = req.cookies?.[APP_SESSION_COOKIE_NAME];
    if (typeof appSessionId !== 'string' || !appSessionId || !forwardedHost) {
      return undefined;
    }

    const appSession = this.sessionManager.resolveAppSession(appSessionId);
    if (!appSession) {
      return undefined;
    }

    const hostAppUrn = await this.forwardAuthSecrets.resolveAppUrnForHost(forwardedHost);
    if (!hostAppUrn || hostAppUrn !== appSession.appUrn) {
      this.logger.debug('Traefik forward auth ignored an app session minted for another app', {
        host: forwardedHost,
        targetApp: hostAppUrn,
        sessionApp: appSession.appUrn,
      });
      return undefined;
    }

    return this.loadAppSessionUser(appSession.userId);
  }

  /**
   * Loaded by `loadSessionUser` and admitted by `refuseRevokedSessionUser`, the rules `AuthMiddleware`
   * applies to a Hub session's user. Forward auth runs for every request an app serves, so neither a
   * row read per request nor a 500 per blip is acceptable here.
   *
   * ⚠ THE ROW REFUSES AN APP SESSION TOO. `revokeOperator` destroys the parent Hub session and
   * `resolveAppSession` refuses an app session whose parent is gone, so a removed operator's app tab
   * is normally signed out before this reads their row. When it is not — the row flipped without
   * `revokeOperator`, or this read landed between the update and the sweep — a `revoked` row still
   * authenticates nothing here: the request goes on as unauthenticated, to the login that
   * `admitHubPerson` refuses, and their sessions are swept on the way.
   */
  private async loadAppSessionUser(userId: number): Promise<UserDto | undefined> {
    let user: UserDto | undefined;
    try {
      user = await loadSessionUser(this.sessionUserCache, this.userRepository, userId);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      // Same as a Hub session whose row cannot be read: carry on without a user.
      return undefined;
    }
    return (await refuseRevokedSessionUser(user, this.sessionManager, this.sessionUserCache, userId)) ? undefined : user;
  }

  /**
   * Whether the forwarded host belongs to the official Companion Memory install
   * — the one app that authenticates its own API keys and public paths. Keyed on
   * install provenance (`isMemoryProviderApp`), so a third-party app named
   * `ci-memory` from another store does not qualify. Unknown host → false.
   */
  private async isMemoryProviderHost(forwardedHost: string): Promise<boolean> {
    if (!forwardedHost) {
      return false;
    }
    const appUrn = await this.forwardAuthSecrets.resolveAppUrnForHost(forwardedHost);
    return appUrn != null && isMemoryProviderApp({ urn: appUrn });
  }

  @Get('/traefik')
  async traefik(@Req() req: Request, @Res() res: Response) {
    const forwardedHost = normalizeForwardedHost(req.headers['x-forwarded-host']);
    const rawHost = rawForwardedHost(req.headers['x-forwarded-host']);
    // Do not comma-split the URI because commas are valid in paths and queries.
    const uri = (req.headers['x-forwarded-uri'] as string | undefined) || '/';
    // Use only the first protocol because repeated headers arrive comma-joined and are not a valid URL scheme.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
    const viaTunnel = this.viaCloudflareTunnel(req);
    const { ticket, cleanUri } = this.parseForwardedUri(uri);

    // An app session planted by edge SSO stands in for `req.user` from here on, ahead of the public
    // paths and the Bearer check just as the Hub session it replaces was: Memory's
    // `/api/authenticate/hub-bridge` is a public path, and it needs the signed identity.
    const forwardAuthUser = req.user ?? (await this.resolveAppSessionUser(req, forwardedHost));

    // Phone Memory returns to a cookie-less webview, so its API authentication must reach the app.
    // Browser HTML remains on cookie or edge SSO. Memory ONLY: for any other app behind edge auth
    // the same request falls through to the Bearer / session checks below and is refused like
    // any other anonymous one. Resolved from the forwarded host, which Traefik sets from the
    // router that matched — not from anything the client sent.
    if (!forwardAuthUser && (isForwardAuthAppPublicPath(cleanUri) || requestHasApiKey(req))) {
      if (await this.isMemoryProviderHost(forwardedHost)) {
        return res.status(200).send();
      }
      this.logger.debug(`Traefik forward auth: Memory-only exemption refused for ${forwardedHost || '(no host)'} ${cleanUri}`);
    }

    // Without a forwarded host `resolveForHost` falls back to the Hub-GLOBAL signing secret, which
    // is the cross-app forgery the per-app secret exists to prevent (CI-Engineering#74), and there
    // is no valid return route to build either. One guard for every branch below rather than one
    // per branch: the Bearer path and the cookie path BOTH sign identity headers, so neither may
    // be allowed to reach `resolveForHost('')`.
    if (!forwardedHost) {
      this.logger.debug('Traefik forward auth rejected a request with no forwarded host');
      return res.status(401).send();
    }

    // Machine clients use Portal bearer tokens, so valid tokens bypass browser SSO.
    // Invalid tokens return 401 instead of login HTML.
    if (!forwardAuthUser) {
      const bearer = extractBearerToken(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
      if (bearer) {
        const portalBase = (this.config.get('ciCloudUrl') || '').replace(/\/+$/, '');
        const claims = await verifyPortalIdToken(bearer, { publicCiCloudUrl: portalBase });
        if (!claims) {
          this.logger.debug('Traefik forward auth rejected Portal Bearer token');
          return res.status(401).send();
        }
        // A verified id_token proves who the caller is to Portal, not that they may act on THIS
        // Hub: the audience list, issuer and signature are identical for every Hub in the fleet
        // (CI-Hub#1333). Bind it to the appliance the same way the cookie/SSO login path does
        // (admitHubPerson -> resolvePairedOrgMembership) before issuing any forward-auth header.
        // The rejection itself is logged inside the helper, once per verdict rather than per request.
        const isMember = await this.isBearerSubjectAuthorizedForThisHub(claims.sub, forwardedHost);
        if (!isMember) {
          return res.status(403).send();
        }
        // The Hub person this subject is, when there is one: their username and stable id, so a
        // machine client arrives at every app as the same person its owner's browser does. A
        // Portal email change never reaches the Hub username, so the claims alone drift from it.
        const person = await this.forwardAuthIdentities.personForPortalSubject(portalBase.trim(), claims.sub.trim());
        const username = person?.username ?? portalClaimsIdentity(claims);
        const resolved = await this.forwardAuthSecrets.resolveForHost(forwardedHost);
        this.logger.debug('Portal Bearer accepted for Traefik forward auth', {
          username,
          hubPerson: Boolean(person),
          secretSource: resolved.source,
          targetApp: resolved.appUrn,
        });
        const signed = buildSignedForwardAuthHeaders(resolved.secret, username, Date.now(), person?.stableId);
        for (const [header, value] of Object.entries(signed)) {
          res.setHeader(header, value);
        }
        return res.status(200).send();
      }
    }

    if (forwardAuthUser) {
      // A ticket on an authenticated request was bypassed by a domain or app-session cookie, so burn it and remove it from the URL.
      // Leaving it valid would preserve a replayable session-planting credential.
      if (ticket) {
        // Check before deleting so junk parameters cannot force synchronous store writes on every app request.
        const lingeringKey = `${EDGE_SSO_CACHE_PREFIX}${ticket}`;
        if (this.cache.get(lingeringKey)) {
          this.cache.del(lingeringKey);
        }
        // Use an absolute, trusted return URL because Traefik rewrites relative locations against the auth server.
        // If no browser-reachable address is known, keep the working page after burning the ticket.
        const returnUrl = await this.buildReturnUrl({ forwardedHost, rawHost, proto, viaTunnel, path: cleanUri });
        if (returnUrl) {
          return res.status(302).redirect(returnUrl);
        }
      }

      // Per-app signing prevents one container from forging identity headers accepted by a sibling (CI-Engineering#74).
      // Unknown hosts retain the Hub-global fallback.
      const resolved = await this.forwardAuthSecrets.resolveForHost(forwardedHost);
      this.logger.debug('User authenticated for Traefik forward auth', {
        username: forwardAuthUser.username,
        secretSource: resolved.source,
        targetApp: resolved.appUrn,
      });
      // The username can change at any time; the stable id beside it cannot (ForwardAuthIdentityResolver).
      const stableId = await this.forwardAuthIdentities.stableIdFor(forwardAuthUser.id);
      const signed = buildSignedForwardAuthHeaders(resolved.secret, forwardAuthUser.username, Date.now(), stableId);
      for (const [header, value] of Object.entries(signed)) {
        res.setHeader(header, value);
      }

      return res.status(200).send();
    }

    // Cache the host-map result because a failed consume falls directly through to mint.
    let cachedPublicHost: string | null | undefined;
    const resolvePublicHostOnce = async (): Promise<string | null> => {
      if (cachedPublicHost === undefined) {
        cachedPublicHost = await this.forwardAuthSecrets.resolvePublicHostForHost(forwardedHost);
      }
      return cachedPublicHost;
    };

    // Never log the raw URI because its ticket is a session-planting credential.
    this.logger.debug('Unauthenticated Traefik forward auth request', { uri: cleanUri, proto, host: forwardedHost });

    // Public Hub and app hosts are cookie-scope siblings, so a single-use ticket plants the app-host cookie (CI-Engineering#77).
    // Consume failures fall through to login and a fresh ticket instead of dead-ending.
    if (ticket) {
      const cacheKey = `${EDGE_SSO_CACHE_PREFIX}${ticket}`;
      const cached = this.cache.get(cacheKey);
      // Avoid synchronous deletes for unauthenticated ticket misses.
      if (cached) {
        this.cache.del(cacheKey); // single-use — burn the real hit before acting on it.
        let sessionId = '';
        let targetHost = '';
        let targetUrl = '';
        let appUrn: AppUrn | undefined;
        try {
          ({ sessionId = '', targetHost = '', targetUrl = '', appUrn } = JSON.parse(cached) as Partial<EdgeSsoTicket>);
        } catch {
          // fall through to the login redirect
        }

        // Host binding prevents a ticket for one app from planting a sibling's cookie.
        // Tunnel requests compare against the exact public host mapped from their rewritten host.
        const publicForHost = targetHost && targetHost !== forwardedHost ? await resolvePublicHostOnce() : null;
        const hostMatches = Boolean(targetHost) && (targetHost === forwardedHost || targetHost === publicForHost);

        // Parse again so malformed cached data falls through to login instead of returning 500.
        let ticketTarget: URL | null = null;
        try {
          ticketTarget = targetUrl ? new URL(targetUrl) : null;
        } catch {
          ticketTarget = null;
        }

        // The session must still resolve — a ticket outliving its session plants nothing — and the
        // ticket must name an app. The session is bound to the app this forwarded host resolves to,
        // the lookup forward auth applies to every later request here. The host binding above already
        // ties the ticket to this host; the app recorded at mint can differ when two apps claim the
        // ticket's hostname, and a session bound to that one would be refused on every request.
        const userId = sessionId && ticketTarget && hostMatches ? this.sessionManager.resolveSessionUserId(sessionId) : null;
        const hostAppUrn = userId && appUrn ? await this.forwardAuthSecrets.resolveAppUrnForHost(forwardedHost) : null;
        if (hostAppUrn && hostAppUrn !== appUrn) {
          this.logger.debug('Edge-SSO ticket names another app that claims this hostname; binding to the forwarded host app', {
            host: forwardedHost,
            ticketApp: appUrn,
            hostApp: hostAppUrn,
          });
        }
        const appSessionId = userId && hostAppUrn ? await this.sessionManager.createAppSession(userId, sessionId, hostAppUrn) : null;
        if (ticketTarget && appSessionId) {
          // ⚠ AN APP SESSION, NEVER `sessionId` ITSELF. Traefik copies every request header, cookies
          // included, to the app it fronts, and the Hub session is a full Hub API credential
          // (`AuthMiddleware` takes it from a cookie, a header, or the query): planting it here would
          // hand the operator's Hub to every app served on this host, and a leaked ticket to whoever
          // redeemed it. This one authenticates forward auth for this host's app and nothing else.
          // Host-only (no Domain), so the browser pins it to the host it actually requested, whatever
          // the tunnel rewrote the forwarded host to, and no sibling or child host receives it. A
          // sibling can still shadow it with a same-name cookie scoped to a shared parent domain.
          res.cookie(APP_SESSION_COOKIE_NAME, appSessionId, {
            httpOnly: true,
            secure: ticketTarget.protocol === 'https:',
            sameSite: 'lax',
            maxAge: SESSION_COOKIE_MAX_AGE,
          });
          return res.status(302).redirect(ticketTarget.toString());
        }
      }
    }

    // The rewritten forwarded host identifies the app but not whether its caller is remote.
    // A `cf-ray` caller must use mapped public Hub and app hosts; other callers retain the LAN route.
    const publicHub = viaTunnel ? await this.resolvePublicHub() : null;
    const publicAppHost = publicHub ? await resolvePublicHostOnce() : null;

    let hubOrigin: string;
    let target: string;
    if (publicHub && publicAppHost) {
      hubOrigin = publicHub.origin;
      target = `https://${publicAppHost}${cleanUri}`;
    } else if (publicHub) {
      // A remote caller with no mapped public app host must not receive an unresolvable LAN return address.
      // Log at debug because this unauthenticated path could amplify warning floods.
      this.logger.debug(`[edge-sso] no public hostname for forwarded host ${forwardedHost}; sending the visitor to the Hub login`);
      return res.status(302).redirect(new URL('/login', publicHub.origin).toString());
    } else {
      // Preserve the raw host so LAN and tailnet callers keep nonstandard ports.
      // IP literals have no parent domain, so reject them before malformed derivation can return the wrong host or throw.
      const rootDomain = net.isIP(forwardedHost.replace(/^\[|]$/g, '')) ? '' : rawHost.split('.').slice(1).join('.');
      // A single-label host also has no safe Hub origin to derive.
      if (!rootDomain) {
        return res.status(401).send();
      }
      hubOrigin = `${proto}://${rootDomain}`;
      target = `${proto}://${rawHost}${cleanUri}`;

      // Unknown LAN routers use direct login because edge SSO would reject their unallowlisted target.
      // The domain-scoped LAN cookie already makes the ticket exchange unnecessary.
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
   * Public sibling hosts cannot share the Hub cookie, so edge SSO uses a short-lived, single-use, host-bound ticket (CI-Engineering#77, ADR 002).
   * Browser navigation must redirect through login instead of returning AuthGuard JSON, while loopback open bypasses this flow under ADR 001.
   * Fetch Metadata cannot gate a redirect chain, so host binding, one-use, short TTL, and authenticated minting mitigate login CSRF.
   */
  @Get('/edge-sso')
  async edgeSso(@Query('redirect') redirect: string | undefined, @Req() req: Request, @Res() res: Response) {
    const validated = await this.validateEdgeSsoTarget(redirect);
    if (!validated) {
      throw new BadRequestException('Unsupported edge SSO target');
    }
    const { url: target, appUrn } = validated;

    const sessionId = req.user ? (req.hubSessionId ?? req.cookies[SESSION_COOKIE_NAME] ?? req.get('x-ci-hub-session')) : undefined;
    if (!sessionId) {
      // Return unauthenticated navigation through normal login with the absolute same-origin URL Portal expects.
      // Force tunnel requests to HTTPS because their internal hop reports HTTP while the browser uses HTTPS.
      // Match the scheme case-insensitively as required by RFC 3986.
      const requestOrigin = resolveRequestOriginFallback(req);
      const origin = this.viaCloudflareTunnel(req) ? requestOrigin.replace(/^http:/i, 'https:') : requestOrigin;
      const selfUrl = new URL('/api/auth/edge-sso', origin);
      selfUrl.searchParams.set('redirect', target.toString());
      const loginUrl = new URL('/login', origin);
      loginUrl.searchParams.set('redirect_url', selfUrl.toString());
      loginUrl.searchParams.set('app', target.hostname.split('.')[0] ?? '');
      return res.status(302).redirect(loginUrl.toString());
    }

    // Cap mints per session and app so a browser that rejects cookies cannot redirect forever.
    const counterKey = `${EDGE_SSO_COUNTER_PREFIX}${sessionId}:${target.hostname}`;
    const mints = Number.parseInt(this.cache.get(counterKey) ?? '0', 10) || 0;
    if (mints >= EDGE_SSO_MAX_MINTS_PER_MINUTE) {
      return res
        .status(409)
        .type('html')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cookies required — Companion Hub</title>' +
            HUB_FAVICON_LINK_TAG +
            '</head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">' +
            '<h1>Cookies required</h1><p>Signing in to this app requires cookies, and your browser ' +
            'does not appear to be accepting them. Enable cookies for this site and try again.</p>' +
            '</body></html>',
        );
    }
    // A fixed window prevents legitimate spaced sign-ins from extending themselves into the cap.
    const windowEndsAt = this.cache.getExpirationAt(counterKey);
    const windowTtl = windowEndsAt ? Math.max(1, Math.ceil((windowEndsAt - Date.now()) / 1000)) : EDGE_SSO_MINT_WINDOW_SECONDS;
    this.cache.set(counterKey, String(mints + 1), windowTtl);

    const ticket = crypto.randomUUID();
    // Keep the session server-side and bind it to one hostname and the app behind it.
    // Store the full browser target because the tunnel-rewritten forwarded host may be remotely unreachable.
    const targetUrl = target.toString();
    this.cache.set(
      `${EDGE_SSO_CACHE_PREFIX}${ticket}`,
      JSON.stringify({ sessionId, targetHost: target.hostname, targetUrl, appUrn } satisfies EdgeSsoTicket),
      EDGE_SSO_TICKET_TTL_SECONDS,
    );

    // Append the ticket raw because URLSearchParams would re-encode unrelated query segments.
    const ticketParam = `${EDGE_SSO_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
    target.search = target.search ? `${target.search}&${ticketParam}` : `?${ticketParam}`;
    return res.status(302).redirect(target.toString());
  }
}
