import { describe, expect, it } from 'vitest';
import { buildPortalSsoStartUrl } from '@/lib/portal-sso-url';
import { hubAuthFlowPolicy } from '@/lib/hub-auth-flow';

/**
 * DESKTOP SIGN-IN MUST NOT DEPEND ON THE LINK INTERCEPTOR. Do not "fix" this.
 *
 * Providers installs a document-level click handler that diverts CROSS-ORIGIN
 * anchors to the system browser. Same-origin ones are deliberately left alone,
 * because they are the app navigating itself.
 *
 * Desktop SSO used to be routed through that handler, and it worked only by
 * accident: buildPortalSsoStartUrl returns an ABSOLUTE url, the old test was
 * `href.startsWith('http')`, and every absolute url passed it. Once same-origin
 * was correctly exempted, the packaged shell — which serves the Hub UI from
 * http://127.0.0.1:<port>, the same origin the start url is built against — began
 * navigating its OWN webview to /portal/start. The whole flow then happens inside
 * the app window: the Portal login page renders with no address bar, no password
 * manager and no working passkey, and the React app that finishes the sign-in
 * is unmounted with it.
 *
 * So desktop does not use an anchor at all. It runs its own PKCE sign-in
 * (desktop-portal-sign-in.ts), which opens the authorize URL in the system browser
 * and receives the code on a 127.0.0.1 loopback redirect:
 *
 *     onClick -> signInDesktopWithPortal -> system browser -> Portal login
 *       -> loopback redirect -> token exchange -> Hub session (no token in a URL)
 *
 * The React app stays mounted the whole time, which is what makes the last step
 * possible. These tests exist to catch a change that puts sign-in back inside the
 * webview, or that brings a token back into a deep link.
 */
describe('desktop portal SSO contract', () => {
  const HUB = 'http://127.0.0.1:5002';

  const desktopStartUrl = () =>
    buildPortalSsoStartUrl({
      remoteHubUrl: null,
      isTauriDesktop: true,
      isMobileClient: false,
      configuredApiBaseUrl: HUB,
      pageOrigin: HUB,
    });

  it('builds an ABSOLUTE start URL, so it can be handed to the OS as-is', () => {
    const url = desktopStartUrl();
    expect(url.startsWith('http')).toBe(true);
    expect(new URL(url).pathname).toBe('/api/auth/portal/start');
  });

  it('is same-origin with the packaged Hub UI — which is why an anchor would stay in-app', () => {
    // This is the condition that makes the interceptor route unusable for
    // sign-in. If it ever stops holding, the reasoning above can be revisited.
    expect(new URL(desktopStartUrl()).origin).toBe(new URL(HUB).origin);
  });

  it('marks the request as a desktop handoff', () => {
    expect(new URL(desktopStartUrl()).searchParams.get('desktop')).toBe('1');
  });

  it('declares its build channel instead of letting the backend infer it', () => {
    // The backend used to infer "loopback origin => dev build", but the packaged
    // app is loopback too, so every production sign-in was handed back on
    // cihub-dev:// — a scheme no installer registers. Under vitest DEV is true,
    // so the dev channel is declared; a production bundle omits it and the
    // backend defaults to 'packaged'.
    const channel = new URL(desktopStartUrl()).searchParams.get('desktop_channel');
    expect(channel === 'dev' || channel === null).toBe(true);
  });

  it('opens sign-in in the system browser and takes no token from a deep link', () => {
    const policy = hubAuthFlowPolicy('desktop-hub-sso');
    // Desktop opens the system browser itself rather than leaning on the
    // interceptor. There is no second tab to worry about: the button branch of
    // login-form renders no anchor for the handler to see.
    expect(policy.openHubSsoInSystemBrowser).toBe(true);
    // The return path is the app's own loopback redirect, not cihub://auth?token=.
    expect(policy.usesDeepLinkHandoff).toBe(false);
    expect(policy.listenDeepLinkAuth).toBe(false);
    expect(policy.announceDesktopPresence).toBe(false);
  });

  it('leaves a plain browser on the Hub navigating in place', () => {
    // browser-hub-sso is the one flow with no webview to preserve.
    expect(hubAuthFlowPolicy('browser-hub-sso').openHubSsoInSystemBrowser).toBe(false);
    expect(hubAuthFlowPolicy('browser-hub-sso').usesDeepLinkHandoff).toBe(false);
  });
});
