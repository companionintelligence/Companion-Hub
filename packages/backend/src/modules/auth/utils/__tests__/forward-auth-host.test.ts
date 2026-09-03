import { describe, expect, it } from 'vitest';
import { normalizeForwardedHost, rawForwardedHost } from '../forward-auth-host';

describe('forward-auth host normalization', () => {
  it('takes the first hop when the header arrives comma-joined from a second proxy', () => {
    // Node joins a REPEATED header into one comma-separated string (only `set-cookie` stays an
    // array), so this — not the array branch — is what a multi-proxy request actually looks like.
    // Unsplit, the key is `app.ci.lan, edge.example`: it matches no host-map entry, so every
    // edge-SSO ticket fails its host binding and the visitor loops back to login silently.
    expect(rawForwardedHost('app.ci.lan, edge.example')).toBe('app.ci.lan');
    expect(normalizeForwardedHost('App.CI.lan:8443, edge.example')).toBe('app.ci.lan');
  });

  it('takes the first value when the header arrives as an array', () => {
    expect(rawForwardedHost(['app.ci.lan', 'edge.example'])).toBe('app.ci.lan');
  });

  it('leaves a single host untouched — a host cannot contain a comma', () => {
    expect(rawForwardedHost(' app.ci.lan:8443 ')).toBe('app.ci.lan:8443');
    expect(normalizeForwardedHost('App.CI.lan:8443')).toBe('app.ci.lan');
  });

  it('does not mistake an IPv6 literal for a host:port pair', () => {
    // A bare `/:\d+$/` strip reads the tail of `2001:db8::1` as a port and truncates it, which
    // would flow onward as a garbage map key and break the "no colon in a normalized host"
    // assumption that callers embedding it in `:`-delimited cache keys rely on.
    expect(normalizeForwardedHost('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeForwardedHost('[::1]:8080')).toBe('[::1]');
  });

  it('returns an empty string for a missing header', () => {
    expect(rawForwardedHost(undefined)).toBe('');
    expect(normalizeForwardedHost(undefined)).toBe('');
  });
});
