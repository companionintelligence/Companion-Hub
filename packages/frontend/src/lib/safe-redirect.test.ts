import { describe, expect, it } from 'vitest';
import { isSafeRedirect } from './safe-redirect';

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
