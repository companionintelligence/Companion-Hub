import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortalDesktopDeepLink,
  buildPortalDesktopErrorDeepLink,
  parseDesktopChannel,
  resolvePortalDesktopDeepLinkScheme,
  buildPortalSsoErrorRedirectUrl,
  exchangePortalAuthorizationCode,
  fetchPortalSessionEmail,
  buildPortalDesktopHandoffHtml,
  desktopSignInWaitProof,
  isDesktopSignInWaitProof,
  isDirectLoopbackRequest,
  isRequestFromThisHost,
  resolvePortalDesktopHandoffState,
  shouldHandoffPortalLoginToDesktop,
  resolvePortalCallbackUrl,
  resolvePortalRootBounce,
  resolveSameOriginRedirectUrl,
  resolveTrustedReturnOrigin,
  toDesktopRedirectPath,
} from '../portal-sso';
import { HUB_FAVICON_LINK_TAG, HUB_FAVICON_PATH } from '../hub-favicon';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import type { Request } from 'express';

function fakeRequest(headers: Record<string, string>, host?: string, protocol = 'http'): Request {
  return {
    headers,
    protocol,
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
  } as unknown as Request;
}

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

// The Hub as it runs on an appliance: in a container whose default gateway is 172.18.0.1.
vi.mock('@/common/helpers/this-host-address', async (importOriginal) =>
  (await import('@/tests/utils/appliance-host-address')).onAppliance(await importOriginal()),
);

/** The page needs three links now; only the deep link varies across these tests. */
function handoffHtml(deepLink: string, overrides: { continueHref?: string; statusHref?: string } = {}) {
  return buildPortalDesktopHandoffHtml({
    deepLink,
    continueHref: overrides.continueHref ?? '/home',
    statusHref: overrides.statusHref ?? '/api/auth/portal/desktop-handoff-status?token=tok',
  });
}

describe('portal-sso helpers', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.get).mockReset();
  });

  it('keeps only same-origin redirect URLs', () => {
    expect(resolveSameOriginRedirectUrl('https://hub.example.com/settings?tab=auth', 'https://hub.example.com')).toBe(
      'https://hub.example.com/settings?tab=auth',
    );
    expect(resolveSameOriginRedirectUrl('https://portal.example.com/home', 'https://hub.example.com')).toBeNull();
  });

  it('converts same-origin redirects into in-app paths for desktop handoff', () => {
    expect(toDesktopRedirectPath('https://hub.example.com/settings?tab=auth#portal', 'https://hub.example.com')).toBe('/settings?tab=auth#portal');
    expect(toDesktopRedirectPath('https://portal.example.com/home', 'https://hub.example.com')).toBe('/home');
  });

  it('builds the Tauri deep link for desktop auth handoff', () => {
    expect(buildPortalDesktopDeepLink('handoff-token')).toBe('cihub://auth?token=handoff-token');
    expect(buildPortalDesktopDeepLink('handoff-token', 'dev')).toBe('cihub-dev://auth?token=handoff-token');
  });

  // The packaged app also serves its UI from loopback, so a loopback origin must
  // NOT imply the dev scheme: that handed every production sign-in back on
  // cihub-dev://, which no installer registers.
  it('keeps the packaged scheme for a loopback hub origin', () => {
    expect(buildPortalDesktopDeepLink('handoff-token', 'packaged')).toBe('cihub://auth?token=handoff-token');
    expect(resolvePortalDesktopDeepLinkScheme('packaged')).toBe('cihub');
    expect(resolvePortalDesktopDeepLinkScheme(null)).toBe('cihub');
    expect(resolvePortalDesktopDeepLinkScheme('dev')).toBe('cihub-dev');
  });

  it('treats an unknown or missing channel as packaged', () => {
    expect(parseDesktopChannel('dev')).toBe('dev');
    expect(parseDesktopChannel('packaged')).toBe('packaged');
    expect(parseDesktopChannel(undefined)).toBe('packaged');
    expect(parseDesktopChannel('nonsense')).toBe('packaged');
  });

  it('builds the Tauri deep link for desktop auth errors', () => {
    expect(buildPortalDesktopErrorDeepLink('callback_error')).toBe('cihub://auth?error=callback_error');
    expect(buildPortalDesktopErrorDeepLink('callback_error', 'dev')).toBe('cihub-dev://auth?error=callback_error');
  });

  it('redirects browser portal errors to the login page', () => {
    expect(
      buildPortalSsoErrorRedirectUrl({
        hubOrigin: 'http://localhost:5002',
        desktop: false,
        errorCode: 'state_expired',
        fallbackOrigin: 'http://localhost:5002',
      }),
    ).toBe('http://localhost:5002/login?portal_error=state_expired');
  });

  it('redirects desktop portal errors to the cihub deep link', () => {
    expect(
      buildPortalSsoErrorRedirectUrl({
        hubOrigin: 'http://localhost:5002',
        desktop: true,
        desktopChannel: 'dev',
        errorCode: 'account_mismatch',
        fallbackOrigin: 'http://localhost:5002',
      }),
    ).toBe('cihub-dev://auth?error=account_mismatch');
  });

  it('builds the hub callback URL from the initiating origin', () => {
    expect(resolvePortalCallbackUrl('http://localhost:5002')).toBe('http://localhost:5002/api/auth/portal/callback');
  });

  it('bounces a path-stripped OAuth return onto the Hub callback', () => {
    expect(resolvePortalRootBounce({ code: 'abc', state: 'xyz', desktop: '1' })).toBe('/api/auth/portal/callback?code=abc&state=xyz');
  });

  it('restarts desktop SSO when the browser lands on /?desktop=1 with no code', () => {
    expect(resolvePortalRootBounce({ desktop: '1' })).toBe('/api/auth/portal/start?desktop=1');
    expect(resolvePortalRootBounce({})).toBeNull();
  });

  it('builds an HTML handoff that opens the desktop deep link', () => {
    const html = handoffHtml('cihub-dev://auth?token=tok-1');
    expect(html).toContain('cihub-dev://auth?token=tok-1');
    expect(html).toContain('Open Companion Hub');
  });

  it('renders the fallback link BEFORE the script that navigates away', () => {
    // The script used to come first. An external-scheme navigation aborts the
    // parse, so the text and the fallback link never rendered and the user was
    // left on a blank white tab with no way forward.
    const html = handoffHtml('cihub://auth?token=tok-2');

    const linkAt = html.indexOf('Open Companion Hub</a>');
    const scriptAt = html.indexOf('location.replace(');
    expect(linkAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeGreaterThan(-1);
    expect(linkAt).toBeLessThan(scriptAt);
  });

  it('navigates exactly once, so the one-time token is not spent twice', () => {
    const html = handoffHtml('cihub://auth?token=tok-3');

    expect(html.match(/location\.replace\(/g)).toHaveLength(1);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('http-equiv=refresh');
  });

  it('is a self-contained page: a title, and no external assets to 404', () => {
    // Served by the API before any session exists, and on a Hub with no frontend
    // bundle there is nothing under /assets to reference. The tab icon is the API's own.
    const html = handoffHtml('cihub://auth?token=tok-4');

    expect(html).toContain('<title>Signing you in — Companion Hub</title>');
    expect(html.match(/<link[^>]+href="[^"]*"/gi)).toEqual([`<link rel="icon" type="image/png" sizes="96x96" href="${HUB_FAVICON_PATH}"`]);
    expect(html).not.toMatch(/<(img|script)[^>]+src=/i);
  });

  it('carries its own tab icon in the head', () => {
    // With no icon link the browser asks for /favicon.ico, which the bundle's SPA
    // fallback answers with index.html, so the tab had no icon.
    const html = handoffHtml('cihub://auth?token=tok-11');
    const head = html.slice(0, html.indexOf('</head>'));

    expect(head).toContain(HUB_FAVICON_LINK_TAG);
  });

  it('navigates a task after parsing, so WebKit still loads the tab icon', () => {
    // WebKit starts icon loads only once the page finishes loading. A
    // location.replace run mid-parse left Safari's tab with no icon at all.
    const html = handoffHtml('cihub://auth?token=tok-12');
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

    expect(script).toContain('setTimeout(function () { location.replace("cihub://auth?token=tok-12"); }, 0);');
    expect(script).not.toMatch(/^\s*location\.replace\(/m);
  });

  it('escapes the deep link in both the href and the inline script', () => {
    const html = handoffHtml('cihub://auth?token=a&b=<c>"d"');

    expect(html).toContain('href="cihub://auth?token=a&amp;b=&lt;c>&quot;d&quot;"');
    // No raw `<` inside the script literal, which could close the tag early.
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script).not.toContain('<c>');
    expect(script).toContain('\\u003c');
  });

  it('offers a way out of the browser tab, not just the app link', () => {
    // Cancel the OS prompt and the old page was a dead end: the only control on
    // it reopened the same prompt. The session cookie is already on this
    // browser, so carrying on here costs nothing.
    const html = handoffHtml('cihub://auth?token=tok-5', { continueHref: '/home?welcome=1' });

    expect(html).toContain('href="/home?welcome=1"');
    expect(html).toContain('Continue in this browser');
  });

  it('arms the status poll BEFORE handing the URL to the OS', () => {
    // Handing off to an external scheme ends the script's run. A setTimeout
    // registered after location.replace is never registered at all, so the page
    // would spin forever even once the app had signed in.
    const html = handoffHtml('cihub://auth?token=tok-6');

    // lastIndexOf, not indexOf: poll() schedules its own retries, and those
    // calls sit above the navigation whatever happens to the arming one. Only
    // the last occurrence says where the poll is actually started.
    const armedAt = html.lastIndexOf('setTimeout(poll,');
    const replaceAt = html.indexOf('location.replace(');
    expect(armedAt).toBeGreaterThan(-1);
    expect(armedAt).toBeLessThan(replaceAt);
  });

  it('polls a link it was given rather than rebuilding one', () => {
    const html = handoffHtml('cihub://auth?token=tok-7', {
      statusHref: '/api/auth/portal/desktop-handoff-status?token=abc%26def',
    });

    expect(html).toContain('"/api/auth/portal/desktop-handoff-status?token=abc%26def"');
  });

  it('never navigates from the poll — the token is single-use', () => {
    // Two navigations spend the token twice: the first exchange succeeds and the
    // second 400s. Only the deep link may navigate, and only once.
    const html = handoffHtml('cihub://auth?token=tok-8');
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

    expect(script.match(/location\.replace\(/g)).toHaveLength(1);
    expect(script).not.toMatch(/location\.(href|assign)\s*=/);
    expect(script).not.toContain('window.open');
  });

  it('promises no auto-close, because a tab the OS opened cannot close itself', () => {
    // Chromium refuses with "Scripts may close only the windows that were opened
    // by them", with or without extra history entries. A countdown would lie.
    const html = handoffHtml('cihub://auth?token=tok-9');

    expect(html).not.toContain('window.close');
    expect(html).toContain('You can close this tab.');
  });

  it('can actually hide the elements it hides', () => {
    // .btn sets display:block, which beats the hidden attribute's UA rule, so
    // `open.hidden = true` would leave the spent app link on screen.
    const html = handoffHtml('cihub://auth?token=tok-10');

    expect(html).toContain('[hidden] { display: none !important; }');
  });

  it('claimed beats pending, so a sign-in is never reported as expired', () => {
    // The exchange writes the marker before it deletes the token, and this reads
    // them in the same order. Both halves are needed: either alone leaves a
    // window where a successful sign-in reads as expired.
    expect(resolvePortalDesktopHandoffState({ claimed: true, pending: true })).toBe('claimed');
    expect(resolvePortalDesktopHandoffState({ claimed: true, pending: false })).toBe('claimed');
    expect(resolvePortalDesktopHandoffState({ claimed: false, pending: true })).toBe('pending');
    expect(resolvePortalDesktopHandoffState({ claimed: false, pending: false })).toBe('expired');
  });

  it('hands loopback SSO to a running Tauri app even without desktop=1', () => {
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'http://localhost:5005',
        desktopAppPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'http://localhost:5005',
        desktopAppPresent: false,
      }),
    ).toBe(false);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: false,
        hubOrigin: 'https://hub-nicemac-devben.companionintelligence.com',
        desktopAppPresent: true,
      }),
    ).toBe(false);
    expect(
      shouldHandoffPortalLoginToDesktop({
        desktop: true,
        hubOrigin: 'https://hub-nicemac-devben.companionintelligence.com',
        desktopAppPresent: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['the desktop window on the published port', true, { host: '127.0.0.1:5002' }, '172.18.0.1'],
    // How Node reports that peer when the server listens on `::`.
    ['the desktop window seen on a dual-stack socket', true, { host: '127.0.0.1:5002' }, '::ffff:172.18.0.1'],
    ['the dev shell through the Vite proxy', true, { host: 'localhost:5005' }, '::1'],
    [
      'a tunnel visitor naming a loopback host',
      false,
      { host: 'hub-device-org.example.com', 'x-forwarded-host': 'localhost:5002', 'cf-ray': '8c1f2e3d4a5b6c7d-AMS' },
      '10.20.0.2',
    ],
    ['a public caller naming a loopback host', false, { host: 'localhost:5002' }, '203.0.113.7'],
    ['a LAN device on the host address', false, { host: '192.168.1.20:5002' }, '192.168.1.50'],
    ['a request with no host at all', false, {}, '172.18.0.1'],
  ])('isDirectLoopbackRequest: %s -> %s', (_caller, expected, headers: Record<string, string>, ip) => {
    const req = {
      headers,
      ip,
      protocol: 'http',
      socket: { remoteAddress: ip },
      get: (name: string) => (name.toLowerCase() === 'host' ? headers.host : undefined),
    } as unknown as Request;

    expect(isDirectLoopbackRequest(req)).toBe(expected);
  });

  it.each([
    ['the setup service on the host, relayed from the gateway', true, { host: '127.0.0.1:5002' }, '172.18.0.1'],
    ['the same on a dual-stack socket', true, { host: '127.0.0.1:5002' }, '::ffff:172.18.0.1'],
    ['a request inside the Hub container on loopback', true, { host: 'localhost:5002' }, '127.0.0.1'],
    ['a LAN machine naming a loopback host', false, { host: '127.0.0.1:5002' }, '192.168.1.50'],
    ['a container calling the Hub on a shared network', false, { host: '127.0.0.1:5002' }, '172.18.0.7'],
    ['the gateway naming another host', false, { host: '192.168.1.10:5002' }, '172.18.0.1'],
    ['the gateway carrying a public forwarded hop', false, { host: '127.0.0.1:5002', 'x-forwarded-for': '203.0.113.9' }, '172.18.0.1'],
    ['the gateway carrying a tunnel marker', false, { host: '127.0.0.1:5002', 'cf-ray': '8c1f2e3d4a5b6c7d-AMS' }, '172.18.0.1'],
    [
      "the Hub's own page in a browser on the host",
      true,
      { host: '127.0.0.1:5002', origin: 'http://127.0.0.1:5002', 'sec-fetch-site': 'same-origin' },
      '172.18.0.1',
    ],
    [
      'a form on another site, in a browser on the host',
      false,
      { host: '127.0.0.1:5002', origin: 'https://other.example', 'sec-fetch-site': 'cross-site' },
      '172.18.0.1',
    ],
    [
      'a form on another site, from a browser that sends no fetch metadata',
      false,
      { host: '127.0.0.1:5002', origin: 'https://other.example' },
      '172.18.0.1',
    ],
    ["an app's page on another loopback port", false, { host: '127.0.0.1:5002', 'sec-fetch-site': 'same-site' }, '172.18.0.1'],
    ['an address typed into a browser on the host', true, { host: '127.0.0.1:5002', 'sec-fetch-site': 'none' }, '127.0.0.1'],
    ['a link followed from another site', false, { host: '127.0.0.1:5002', 'sec-fetch-site': 'cross-site' }, '127.0.0.1'],
  ])('isRequestFromThisHost: %s -> %s', (_caller, expected, headers: Record<string, string>, ip) => {
    const req = {
      headers,
      ip,
      protocol: 'http',
      socket: { remoteAddress: ip },
      get: (name: string) => (name.toLowerCase() === 'host' ? headers.host : undefined),
    } as unknown as Request;

    expect(isRequestFromThisHost(req)).toBe(expected);
  });

  it('isRequestFromThisHost reads the socket, not the address HUB_TRUST_PROXY resolved from a header', () => {
    const headers = { host: '127.0.0.1:5002', 'x-forwarded-for': '127.0.0.1' };
    const req = {
      headers,
      ip: '127.0.0.1',
      protocol: 'http',
      socket: { remoteAddress: '192.168.1.50' },
      get: (name: string) => (name.toLowerCase() === 'host' ? headers.host : undefined),
    } as unknown as Request;

    expect(isDirectLoopbackRequest(req)).toBe(true);
    expect(isRequestFromThisHost(req)).toBe(false);
  });

  it('derives the desktop proof the way the desktop shell does', () => {
    // The same key, nonce and proof are asserted in desktop_sign_in_wait.rs, so the two halves cannot drift.
    expect(desktopSignInWaitProof('3f'.repeat(32), '00112233445566778899aabbccddeeff'.repeat(2))).toBe(
      '7a460e26999017e65eaa1c282c52201b9b79bb408fdbd2e0893b1af334e84bc2',
    );
  });

  describe('isDesktopSignInWaitProof', () => {
    const KEY = '3f'.repeat(32);
    const NONCE = 'ab'.repeat(32);
    const proof = desktopSignInWaitProof(KEY, NONCE);

    it.each([
      ['the proof for this nonce', true, proof],
      ['the proof for another nonce', false, desktopSignInWaitProof(KEY, 'cd'.repeat(32))],
      ['a proof made with another key', false, desktopSignInWaitProof('a'.repeat(64), NONCE)],
      ['the key itself', false, KEY],
      ['a proof of the wrong length', false, proof.slice(0, 10)],
      ['a proof with stray whitespace', false, ` ${proof}\n`],
      ['a repeated proof header', false, [proof]],
      ['no proof', false, undefined],
    ])('%s -> %s', (_case, expected, presented: unknown) => {
      expect(isDesktopSignInWaitProof(presented, NONCE, KEY)).toBe(expected);
    });

    it('refuses every proof while the Hub has no key', () => {
      expect(isDesktopSignInWaitProof(desktopSignInWaitProof('', NONCE), NONCE, null)).toBe(false);
    });

    it('refuses a wrong-length proof without throwing', () => {
      expect(() => isDesktopSignInWaitProof('ab', NONCE, KEY)).not.toThrow();
    });
  });

  it('exchanges authorization codes for user email via Portal OAuth endpoints', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { access_token: 'access-token' },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { email: 'operator@example.com', email_verified: true },
    });

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      ok: true,
      accessToken: 'access-token',
      email: 'operator@example.com',
      emailVerified: true,
      subject: null,
      issuer: 'https://hub.ci.computer',
    });
  });

  it.each([
    ['unverified', false],
    ['absent', undefined],
  ])('refuses a userinfo email whose email_verified is %s', async (_label, emailVerified) => {
    // The Hub decides who its operator is by comparing this address. Accepting it unverified would
    // let anyone claim a Hub by typing its operator's address into a Portal signup form.
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { access_token: 'access-token' },
    });
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { email: 'operator@example.com', email_verified: emailVerified },
    });

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'email_unverified',
      status: 200,
    });
  });

  it.each([
    ['token', 'post'],
    ['userinfo', 'get'],
  ] as const)('says why the %s request got no answer when no address of the Portal accepted it', async (_label, method) => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { access_token: 'access-token' } });
    vi.mocked(axios[method]).mockRejectedValue(axiosEveryAddressFailed());

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({ ok: false, reason: 'network_error', detail: EVERY_ADDRESS_FAILED });
  });

  it('returns a structured failure when token exchange fails', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      status: 400,
      data: { error: 'invalid_grant' },
    });

    await expect(
      exchangePortalAuthorizationCode({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        callbackUrl: 'http://localhost:5002/api/auth/portal/callback',
        code: 'auth-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'token_exchange_failed',
      status: 400,
    });
  });

  describe('resolveTrustedReturnOrigin', () => {
    const trusted = { domain: 'companionintelligence.com', localDomain: 'companionintelligence.com' };

    it('returns the origin for localhost', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({}, 'localhost:5002'), trusted)).toBe('http://localhost:5002');
    });

    it('returns the origin for the configured domain and its subdomains', () => {
      expect(
        resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub-abc.companionintelligence.com' }), trusted),
      ).toBe('https://hub-abc.companionintelligence.com');
      expect(
        resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'companionintelligence.com' }), trusted),
      ).toBe('https://companionintelligence.com');
    });

    it('omits the origin for untrusted hosts (host header injection)', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-host': 'attacker.example.com' }, 'localhost:5002'), trusted)).toBeUndefined();
      // A lookalike suffix must not match the trusted domain.
      expect(resolveTrustedReturnOrigin(fakeRequest({ 'x-forwarded-host': 'evilcompanionintelligence.com' }), trusted)).toBeUndefined();
    });

    it('uses only the first value of a comma-separated forwarded host', () => {
      expect(
        resolveTrustedReturnOrigin(
          fakeRequest({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'hub.companionintelligence.com, attacker.example.com' }),
          trusted,
        ),
      ).toBe('https://hub.companionintelligence.com');
    });

    it('returns undefined when no host is present', () => {
      expect(resolveTrustedReturnOrigin(fakeRequest({}), trusted)).toBeUndefined();
    });
  });

  it('reads the signed-in Portal account email from get-session', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { user: { email: 'portal@example.com' } },
    });

    await expect(
      fetchPortalSessionEmail({
        publicPortalBaseUrl: 'https://hub.ci.computer',
        cookieHeader: 'ci.session=abc',
      }),
    ).resolves.toBe('portal@example.com');
  });
});
