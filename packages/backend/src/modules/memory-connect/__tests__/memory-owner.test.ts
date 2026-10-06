import { describe, expect, it } from 'vitest';
import { applyMemoryOwnerEnv, MEMORY_OWNER_ENV, pickPortalIdentity } from '../memory-owner';

const HUB = { issuer: 'urn:ci-hub:6f1c2a4e-2f3b-4c5d-8e9f-0a1b2c3d4e5f', subject: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b' };
const PORTAL = { issuer: 'https://hub.ci.computer', subject: 'portal-user-1' };

describe('memory owner environment', () => {
  it('names the variables Companion Memory reads', () => {
    expect(MEMORY_OWNER_ENV).toEqual({
      email: 'CI_OWNER_EMAIL',
      hubIssuer: 'CI_OWNER_HUB_ISSUER',
      hubSubject: 'CI_OWNER_HUB_SUBJECT',
      portalIssuer: 'CI_OWNER_PORTAL_ISSUER',
      portalSubject: 'CI_OWNER_PORTAL_SUBJECT',
    });
  });

  it('writes every identity the Hub knows for its owner', () => {
    const env = new Map<string, string>();

    applyMemoryOwnerEnv(env, { username: 'owner@example.com', hub: HUB, portal: PORTAL });

    expect(Object.fromEntries(env)).toEqual({
      CI_OWNER_EMAIL: 'owner@example.com',
      CI_OWNER_HUB_ISSUER: HUB.issuer,
      CI_OWNER_HUB_SUBJECT: HUB.subject,
      CI_OWNER_PORTAL_ISSUER: PORTAL.issuer,
      CI_OWNER_PORTAL_SUBJECT: PORTAL.subject,
    });
  });

  it('leaves out what it does not know rather than guessing', () => {
    const env = new Map<string, string>();

    applyMemoryOwnerEnv(env, { username: 'owner@example.com', hub: HUB, portal: null });

    expect(env.has('CI_OWNER_PORTAL_SUBJECT')).toBe(false);
    expect(env.get('CI_OWNER_HUB_SUBJECT')).toBe(HUB.subject);
  });

  it('clears a stale owner when there is none to name', () => {
    const env = new Map<string, string>([
      ['CI_OWNER_EMAIL', 'former@example.com'],
      ['CI_OWNER_HUB_SUBJECT', 'stale'],
      ['APP_PORT', '8642'],
    ]);

    applyMemoryOwnerEnv(env, null);

    expect(Object.fromEntries(env)).toEqual({ APP_PORT: '8642' });
  });

  describe('pickPortalIdentity', () => {
    it('prefers the link from the Portal Memory trusts', () => {
      expect(pickPortalIdentity([{ issuer: 'https://other.example', subject: 'x' }, PORTAL], 'https://hub.ci.computer/')).toEqual(PORTAL);
    });

    it('takes the only link there is', () => {
      expect(pickPortalIdentity([PORTAL], undefined)).toEqual(PORTAL);
    });

    it('names nobody when it cannot tell which link is the owner', () => {
      expect(pickPortalIdentity([], 'https://hub.ci.computer')).toBeNull();
      expect(pickPortalIdentity([PORTAL, { issuer: 'https://hub.ci.computer', subject: 'second' }], PORTAL.issuer)).toBeNull();
    });
  });
});
