import { describe, expect, it } from 'vitest';
import { linksForCurrentPortal, portalOrigin } from '../portal-links';

describe('portalOrigin', () => {
  it('reads a token issuer with a path and a Portal URL with a slash as the same Portal', () => {
    expect(portalOrigin('https://Hub.Example.com/api/auth')).toBe('https://hub.example.com');
    expect(portalOrigin('https://hub.example.com/')).toBe('https://hub.example.com');
  });

  it('keeps a port, and has nothing for an empty value', () => {
    expect(portalOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(portalOrigin('  ')).toBeNull();
    expect(portalOrigin(undefined)).toBeNull();
  });

  it('compares a value without a web scheme as written, not as the opaque origin every such value shares', () => {
    expect(portalOrigin('localhost:8787/')).toBe('localhost:8787');
    expect(portalOrigin('urn:ci-hub:x')).toBe('urn:ci-hub:x');
  });
});

describe('linksForCurrentPortal', () => {
  const prod = { issuer: 'https://prod.example.com/api/auth', subject: 'prod-sub' };
  const staging = { issuer: 'https://staging.example.com', subject: 'staging-sub' };

  it("keeps only the paired Portal's links when the person has one", () => {
    expect(linksForCurrentPortal([prod, staging], 'https://staging.example.com/')).toEqual([staging]);
  });

  it('keeps every link when none came from the paired Portal, or no Portal is configured', () => {
    expect(linksForCurrentPortal([prod], 'https://staging.example.com')).toEqual([prod]);
    expect(linksForCurrentPortal([prod, staging], undefined)).toEqual([prod, staging]);
  });

  it('treats a link with no issuer as from another Portal', () => {
    const unknown = { subject: 'old' };
    expect(linksForCurrentPortal([unknown, staging], 'https://staging.example.com')).toEqual([staging]);
    expect(linksForCurrentPortal([unknown], 'https://staging.example.com')).toEqual([unknown]);
  });

  it('counts a link from the token issuer the Hub is set to accept, on another host than the Portal URL', () => {
    const auth = { issuer: 'https://auth.staging.example.com/api/auth', subject: 'staging-sub' };
    expect(linksForCurrentPortal([prod, auth], 'https://staging.example.com', 'https://auth.staging.example.com/api/auth')).toEqual([auth]);
    expect(linksForCurrentPortal([prod, auth], 'https://staging.example.com', null)).toEqual([prod, auth]);
  });

  it('does not match unrelated values that have no web scheme', () => {
    const other = { issuer: 'urn:other', subject: 'other-sub' };
    const current = { issuer: 'localhost:8787', subject: 'current-sub' };
    expect(linksForCurrentPortal([other, current], 'localhost:8787', null)).toEqual([current]);
  });
});
