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

  /*
   * A DID sign-in binds a key in the same table, under the issuer `did:key`. Every caller sends the
   * subject it gets here to Portal as a person id, and "every link" is what comes back when none is from
   * the current Portal, so a DID that survived would be answered "not a member" and revoke its person.
   */
  describe('a DID link (issuer did:key)', () => {
    const did = { issuer: 'did:key', subject: 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw' };

    it('is never one of the links to ask Portal about', () => {
      expect(linksForCurrentPortal([did, staging], 'https://staging.example.com')).toEqual([staging]);
      expect(linksForCurrentPortal([did, staging], undefined)).toEqual([staging]);
    });

    it('is not returned by the every-link fallbacks either', () => {
      expect(linksForCurrentPortal([did, prod], 'https://staging.example.com')).toEqual([prod]);
      expect(linksForCurrentPortal([did], 'https://staging.example.com')).toEqual([]);
      expect(linksForCurrentPortal([did], undefined)).toEqual([]);
      expect(linksForCurrentPortal([did], 'https://staging.example.com', 'https://auth.staging.example.com')).toEqual([]);
    });

    it('is recognised whatever the case or padding of the method', () => {
      expect(linksForCurrentPortal([{ issuer: ' DID:KEY ', subject: 'x' }, prod], undefined)).toEqual([prod]);
    });

    it('is the rule for every DID method, not only did:key: a did:web or a did:keri issuer is dropped as well', () => {
      const web = { issuer: 'did:web:example.com', subject: 'did:web:example.com' };
      const keri = { issuer: 'did:keri:Dabc', subject: 'Dabc' };

      expect(linksForCurrentPortal([web, keri, prod], undefined)).toEqual([prod]);
      expect(linksForCurrentPortal([web, keri, prod], 'https://staging.example.com')).toEqual([prod]);
      expect(linksForCurrentPortal([web, keri], undefined)).toEqual([]);
    });

    it('leaves a Portal link whose issuer merely contains "did" alone', () => {
      const lookalike = { issuer: 'https://did.example.com', subject: 'portal-sub' };
      expect(linksForCurrentPortal([lookalike], undefined)).toEqual([lookalike]);
    });
  });
});
