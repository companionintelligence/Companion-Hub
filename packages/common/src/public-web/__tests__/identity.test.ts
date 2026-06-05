import { describe, expect, it } from 'vitest';
import { buildFqdnSubdomain, buildPublicWebIdentity, resolvePublicDomainRoot, sanitizeAppSubdomain } from '../identity.js';

describe('sanitizeAppSubdomain', () => {
  it('strips dots and sanitizes invalid characters', () => {
    expect(sanitizeAppSubdomain('DocMostp.red')).toBe('docmostp');
    expect(sanitizeAppSubdomain('My_App!')).toBe('my-app');
  });
});

describe('resolvePublicDomainRoot', () => {
  it('uses config domain by default', () => {
    expect(
      resolvePublicDomainRoot({
        configDomain: 'companionintelligence.com',
      }),
    ).toBe('companionintelligence.com');
  });

  it('collapses env domain when it extends config domain', () => {
    expect(
      resolvePublicDomainRoot({
        envDomain: 'dev-acme.companionintelligence.com',
        configDomain: 'companionintelligence.com',
      }),
    ).toBe('companionintelligence.com');
  });

  it('preserves explicit user-selected domain even when it extends config domain', () => {
    expect(
      resolvePublicDomainRoot({
        selectedPublicDomain: 'dev-acme.companionintelligence.com',
        configDomain: 'companionintelligence.com',
      }),
    ).toBe('dev-acme.companionintelligence.com');
  });
});

describe('buildPublicWebIdentity', () => {
  it('builds default companionintelligence.com hostname with device slug', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      hubSubdomain: 'hub-dev-acme-myorg',
      orgSlug: 'myorg',
      publicDomainRoot: 'companionintelligence.com',
    });

    expect(identity).toEqual({
      appSubdomain: 'nextcloud',
      publicDomainRoot: 'companionintelligence.com',
      hostname: 'nextcloud-dev-acme-myorg.companionintelligence.com',
      publicUrl: 'https://nextcloud-dev-acme-myorg.companionintelligence.com',
      originServerName: 'nextcloud-dev-acme-myorg.companionintelligence.com',
    });
  });

  it('builds alternate lifescope.io domain', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      hubSubdomain: 'hub-dev1-myorg',
      orgSlug: 'myorg',
      publicDomainRoot: 'lifescope.io',
    });

    expect(identity.hostname).toBe('nextcloud-dev1-myorg.lifescope.io');
    expect(identity.publicUrl).toBe('https://nextcloud-dev1-myorg.lifescope.io');
  });

  it('builds multi-label domain my.lifescope.io', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      hubSubdomain: 'hub-dev1-myorg',
      orgSlug: 'myorg',
      publicDomainRoot: 'my.lifescope.io',
    });

    expect(identity.hostname).toBe('nextcloud-dev1-myorg.my.lifescope.io');
  });

  it('omits device slug when it equals org slug', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      hubSubdomain: 'hub-myorg-myorg',
      orgSlug: 'myorg',
      publicDomainRoot: 'companionintelligence.com',
    });

    expect(identity.hostname).toBe('nextcloud-myorg.companionintelligence.com');
  });

  it('builds hostname without org when orgSlug is missing', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      publicDomainRoot: 'companionintelligence.com',
    });

    expect(identity.hostname).toBe('nextcloud.companionintelligence.com');
  });

  it('builds hostname without device slug when hubSubdomain is null', () => {
    const identity = buildPublicWebIdentity({
      appSubdomain: 'nextcloud',
      hubSubdomain: null,
      orgSlug: 'myorg',
      publicDomainRoot: 'companionintelligence.com',
    });

    expect(identity.hostname).toBe('nextcloud-myorg.companionintelligence.com');
  });
});

describe('buildFqdnSubdomain', () => {
  it('matches Portal-style sanitized subdomain', () => {
    expect(buildFqdnSubdomain('DocMostp.red', 'hub-test1-myorg', 'myorg')).toBe('docmostp-test1-myorg');
  });
});
