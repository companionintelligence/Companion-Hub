import { describe, expect, it } from 'vitest';

import { keepsPublishedDomain, preselectedPublicDomain, publicDomainToUse } from './preselected-public-domain';

const domains = [
  { id: 'own', domain: 'companionintelligence.com', isDefault: false, offered: false },
  { id: 'pool', domain: 'ci1.pw', isDefault: true, offered: true },
];

const base = {
  availableDomains: domains,
  currentPublicDomain: 'companionintelligence.com',
  hubDomain: 'companionintelligence.com',
  dirty: false,
  isEdit: false,
};

describe('preselectedPublicDomain', () => {
  it('gives a new install the domain Companion Portal preselects', () => {
    expect(preselectedPublicDomain(base)).toBe('ci1.pw');
  });

  it('gives a new install that has no domain yet the preselection too', () => {
    expect(preselectedPublicDomain({ ...base, currentPublicDomain: undefined })).toBe('ci1.pw');
  });

  it('falls back to the first domain when Companion Portal marks none default', () => {
    expect(preselectedPublicDomain({ ...base, availableDomains: domains.map((entry) => ({ ...entry, isDefault: false })) })).toBe(
      'companionintelligence.com',
    );
  });

  it('never moves an installed app', () => {
    expect(preselectedPublicDomain({ ...base, isEdit: true })).toBeNull();
    expect(preselectedPublicDomain({ ...base, isEdit: true, initialExposureMode: 'cloudflare' })).toBeNull();
  });

  it('gives an installed app its first public address the preselection too', () => {
    expect(preselectedPublicDomain({ ...base, isEdit: true, initialExposureMode: 'local' })).toBe('ci1.pw');
    expect(preselectedPublicDomain({ ...base, isEdit: true, initialExposureMode: 'tailscale' })).toBe('ci1.pw');
  });

  it('never overrides a domain the operator picked', () => {
    expect(preselectedPublicDomain({ ...base, dirty: true })).toBeNull();
  });

  it('never overrides a domain the form opened with that Companion Portal offers', () => {
    const offered = [...domains, { id: 'brand', domain: 'lifescope.io', isDefault: false, offered: true }];

    expect(preselectedPublicDomain({ ...base, availableDomains: offered, currentPublicDomain: 'lifescope.io' })).toBeNull();
    expect(preselectedPublicDomain({ ...base, availableDomains: offered, currentPublicDomain: 'LifeScope.io' })).toBeNull();
  });

  /*
   * A retried install's earlier choice, or a config imported from another Hub, can name a domain
   * Companion Portal no longer offers — a full zone, or a Portal zone like `ci.computer`. A new name
   * there is refused, so the form takes the preselection instead of opening on a domain it would then
   * report as unable to take the app.
   */
  it('replaces a domain the form opened with that Companion Portal does not offer', () => {
    expect(preselectedPublicDomain({ ...base, currentPublicDomain: 'lifescope.io' })).toBe('ci1.pw');
    expect(preselectedPublicDomain({ ...base, currentPublicDomain: 'ci.computer', hubDomain: 'ci.computer' })).toBe('ci1.pw');
  });

  it('does nothing with no domains to choose from', () => {
    expect(preselectedPublicDomain({ ...base, availableDomains: [] })).toBeNull();
  });
});

describe('keepsPublishedDomain', () => {
  it('keeps the domain of an installed app served on the Web', () => {
    expect(keepsPublishedDomain(true, 'cloudflare')).toBe(true);
    // Saved before exposure modes existed: served on the Web.
    expect(keepsPublishedDomain(true, undefined)).toBe(true);
  });

  it('treats a new install, and an installed app first moving to the Web, as a new name', () => {
    expect(keepsPublishedDomain(false, undefined)).toBe(false);
    expect(keepsPublishedDomain(false, 'cloudflare')).toBe(false);
    expect(keepsPublishedDomain(true, 'local')).toBe(false);
    expect(keepsPublishedDomain(true, 'tailscale')).toBe(false);
  });
});

/*
 * The Hub is `hub-…ci.computer`. `ci.computer` is a Portal zone and takes no new names, so a new name
 * must never be shown or checked there before Companion Portal's list gives it a domain.
 */
describe('publicDomainToUse', () => {
  const offered = [
    { id: 'ci0', domain: 'ci0.pw', isDefault: true, offered: true },
    { id: 'ci1', domain: 'ci1.pw', isDefault: false, offered: true },
  ];
  const newName = {
    chosen: undefined as string | undefined,
    hubDomain: 'ci.computer',
    keepsPublished: false,
    availableDomains: offered,
    listNote: undefined,
  } as const;

  it('has no domain while the list is loading, whatever the field holds', () => {
    expect(publicDomainToUse({ ...newName, availableDomains: [], listNote: 'loading' })).toBeUndefined();
    expect(publicDomainToUse({ ...newName, chosen: 'ci.computer', availableDomains: [], listNote: 'loading' })).toBeUndefined();
  });

  it('has no domain when the list could not be loaded', () => {
    expect(publicDomainToUse({ ...newName, availableDomains: [], listNote: 'unavailable' })).toBeUndefined();
  });

  it('uses a domain the list offers', () => {
    expect(publicDomainToUse({ ...newName, chosen: 'ci1.pw' })).toBe('ci1.pw');
    expect(publicDomainToUse({ ...newName, chosen: ' ci1.pw ' })).toBe('ci1.pw');
  });

  it('has no domain until one the list offers is chosen', () => {
    expect(publicDomainToUse({ ...newName, chosen: undefined })).toBeUndefined();
    expect(publicDomainToUse({ ...newName, chosen: '' })).toBeUndefined();
    expect(publicDomainToUse({ ...newName, chosen: 'ci.computer' })).toBeUndefined();
  });

  it("falls back to the Hub's own domain only where it is the one domain there is", () => {
    expect(publicDomainToUse({ ...newName, availableDomains: [], listNote: 'none-offered' })).toBe('ci.computer');
    // A Hub too old to say whether it got an answer.
    expect(publicDomainToUse({ ...newName, availableDomains: [], listNote: undefined })).toBe('ci.computer');
    // What the form already holds wins, as it did before.
    expect(publicDomainToUse({ ...newName, chosen: 'ci0.pw', availableDomains: [], listNote: 'none-offered' })).toBe('ci0.pw');
  });

  it('keeps the domain an app on the Web serves from, loaded or not', () => {
    const published = { ...newName, keepsPublished: true };

    expect(publicDomainToUse({ ...published, chosen: 'ci.computer', availableDomains: [], listNote: 'loading' })).toBe('ci.computer');
    expect(publicDomainToUse({ ...published, chosen: 'ci.computer' })).toBe('ci.computer');
    // Saved with no domain: it serves from the Hub's own.
    expect(publicDomainToUse({ ...published, chosen: undefined, availableDomains: [], listNote: 'unavailable' })).toBe('ci.computer');
  });
});
