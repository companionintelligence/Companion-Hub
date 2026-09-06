import { describe, expect, it } from 'vitest';
import { buildPortalSsoStartUrl } from '@/lib/portal-sso-url';
import { hubAuthFlowPolicy } from '@/lib/hub-auth-flow';

/**
 * THE DESKTOP SIGN-IN ANCHOR MUST REACH THE SYSTEM BROWSER. Do not "fix" this.
 *
 * Providers installs a document-level click handler that diverts any anchor whose
 * href starts with 'http' to openExternal. On the packaged desktop app the Hub UI
 * is served from http://127.0.0.1:<port>, so the Hub's own sign-in link is an
 * ABSOLUTE, SAME-ORIGIN http URL — and it is diverted to the system browser.
 *
 * That looks like a bug. It is the mechanism. Desktop SSO is:
 *
 *     <a href> -> interceptor -> system browser -> Portal login
 *       -> cihub://auth?token=... -> Tauri deep link -> token exchange
 *
 * hub-auth-flow.ts sets usesDeepLinkHandoff and listenDeepLinkAuth for
 * desktop-hub-sso, and announceDesktopPresence is documented as a "Desktop-only
 * heartbeat so a Chrome loopback callback can hand off into Tauri" — the callback
 * is EXPECTED to land in Chrome. portal-sso-url.ts warns against also calling
 * openAuthInSystemBrowser because it "opens a second tab": second, because the
 * anchor already opened the first.
 *
 * Adding a same-origin exemption to that interceptor makes the webview navigate
 * to /portal/start itself. The backend then answers with the handoff interstitial,
 * whose whole body is location.replace('cihub://auth?token=...'), which unmounts
 * the React app — and DesktopPortalAuthListener, the only code that exchanges the
 * one-time token, goes with it. The user is stranded on "Opening the Companion
 * Hub app…" with the token parked in a Rust mutex. These tests exist to catch
 * that change.
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

  it('builds an ABSOLUTE start URL, which is why the interceptor sees it at all', () => {
    const url = desktopStartUrl();
    expect(url.startsWith('http')).toBe(true);
    expect(new URL(url).pathname).toBe('/api/auth/portal/start');
  });

  it('is same-origin with the Hub UI — so a same-origin exemption WOULD break it', () => {
    // If this ever stops being true the interceptor no longer governs sign-in and
    // the warning above can be revisited. Until then, it does.
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

  it('keeps the deep-link return path enabled for desktop', () => {
    const policy = hubAuthFlowPolicy('desktop-hub-sso');
    expect(policy.usesDeepLinkHandoff).toBe(true);
    expect(policy.listenDeepLinkAuth).toBe(true);
    expect(policy.announceDesktopPresence).toBe(true);
    // Desktop must NOT call openAuthInSystemBrowser itself — the anchor plus the
    // interceptor already do that, and calling it too opens a second tab.
    expect(policy.openHubSsoInSystemBrowser).toBe(false);
  });
});
