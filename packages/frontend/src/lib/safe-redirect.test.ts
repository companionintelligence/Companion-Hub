import { describe, expect, it } from 'vitest';
import { followSafeRedirect, isSafeRedirect, resolveSafeRedirect } from './safe-redirect';

// Post-login redirect targets. This is open-redirect protection: anything that escapes the Hub's
// origin must be rejected, including the encodings a naive prefix check does not survive.
const HUB = { origin: 'https://hub.example.com', host: 'hub.example.com', protocol: 'https:' };

describe('isSafeRedirect', () => {
  it('allows relative paths', () => {
    expect(isSafeRedirect('/home', HUB)).toBe(true);
    expect(isSafeRedirect('/api/auth/edge-sso?redirect=x', HUB)).toBe(true);
  });

  it('allows a same-origin absolute URL (the edge-SSO return address)', () => {
    expect(isSafeRedirect('https://hub.example.com/api/auth/edge-sso?redirect=https%3A%2F%2Fapp', HUB)).toBe(true);
  });

  it('keeps the historical LAN shape: same-scheme subdomains of the Hub host', () => {
    expect(isSafeRedirect('https://app.hub.example.com/dashboard', HUB)).toBe(true);
  });

  it('rejects every off-origin escape a prefix check would miss', () => {
    // `\` is normalized to `/` by URL parsers, so this is protocol-relative in disguise:
    // it passes `startsWith('/') && !startsWith('//')` but navigates to evil.com.
    expect(isSafeRedirect('/\\evil.com', HUB)).toBe(false);
    expect(isSafeRedirect('//evil.com/phish', HUB)).toBe(false);
    expect(isSafeRedirect('https://evil.com/', HUB)).toBe(false);
    // Suffix lookalike: not actually a subdomain of the Hub host.
    expect(isSafeRedirect('https://evilhub.example.com/', HUB)).toBe(false);
  });

  it('rejects non-http(s) schemes, including the one that reports the Hub origin as its own', () => {
    // WHATWG gives a `blob:` URL the origin of its INNER url, so this compares EQUAL to
    // `location.origin` — origin equality alone is not a scheme check. `javascript:` and `data:`
    // get the opaque origin `"null"` and were already excluded; `blob:` was not.
    expect(isSafeRedirect('blob:https://hub.example.com/9a1f-uuid', HUB)).toBe(false);
    expect(isSafeRedirect('javascript:alert(1)', HUB)).toBe(false);
    expect(isSafeRedirect('data:text/html,<script>alert(1)</script>', HUB)).toBe(false);
  });

  it('refuses to downgrade the scheme on a subdomain target', () => {
    // The backend's own target validator will not hand out a downgraded scheme; this is the
    // same decision client-side.
    expect(isSafeRedirect('http://app.hub.example.com/x', HUB)).toBe(false);
  });

  it('returns false instead of throwing on unparsable input', () => {
    // The original implementation called new URL(url) bare, which THREW on a relative
    // redirect_url and took the login page down mid-render.
    expect(isSafeRedirect('http://[', HUB)).toBe(false);
  });
});

describe('resolveSafeRedirect', () => {
  it('returns the absolute URL the caller must navigate to, not the raw input', () => {
    // `followSafeRedirect` assigns this result rather than the raw string. Assigning the raw
    // string re-resolves it against the current PATH, so a path-relative value validated here as
    // `/home` would land on `/apps/foo/home` from a nested login route — the browser going
    // somewhere other than the address that was checked.
    expect(resolveSafeRedirect('home', HUB)).toBe('https://hub.example.com/home');
    expect(resolveSafeRedirect('/home', HUB)).toBe('https://hub.example.com/home');
  });

  it('returns null for anything isSafeRedirect rejects', () => {
    expect(resolveSafeRedirect('/\\evil.com', HUB)).toBeNull();
    expect(resolveSafeRedirect('https://evil.com/', HUB)).toBeNull();
    expect(resolveSafeRedirect('http://[', HUB)).toBeNull();
  });
});

describe('followSafeRedirect', () => {
  // jsdom refuses a real navigation, so `location` is replaced with a plain object whose `href`
  // simply records what was assigned.
  const withLocation = (href: string, run: () => void) => {
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    const stub = { ...HUB, href };
    Object.defineProperty(window, 'location', { value: stub, configurable: true, writable: true });
    try {
      run();
      return stub.href;
    } finally {
      if (original) {
        Object.defineProperty(window, 'location', original);
      }
    }
  };

  it('navigates to the resolved URL, not the raw string', () => {
    // The address that was judged safe must be the address the browser goes to. Assigning the raw
    // value re-resolves it against the current PATH, sending a visitor on a nested login route to
    // `/apps/foo/home` after `/home` passed the check.
    const landed = withLocation('https://hub.example.com/apps/foo/login', () => {
      expect(followSafeRedirect('home')).toBe(true);
    });
    expect(landed).toBe('https://hub.example.com/home');
  });

  it('reports false and does not navigate for an unsafe target', () => {
    const landed = withLocation('https://hub.example.com/login', () => {
      expect(followSafeRedirect('https://evil.com/')).toBe(false);
      expect(followSafeRedirect(null)).toBe(false);
    });
    expect(landed).toBe('https://hub.example.com/login');
  });
});
