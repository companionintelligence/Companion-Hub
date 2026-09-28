import { describe, expect, it } from 'vitest';

import { preselectedPublicDomain } from './preselected-public-domain';

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
  });

  it('never overrides a domain the operator picked', () => {
    expect(preselectedPublicDomain({ ...base, dirty: true })).toBeNull();
  });

  it('never overrides a domain the form opened with that is not the Hub fallback', () => {
    expect(preselectedPublicDomain({ ...base, currentPublicDomain: 'lifescope.io' })).toBeNull();
  });

  it('does nothing with no domains to choose from', () => {
    expect(preselectedPublicDomain({ ...base, availableDomains: [] })).toBeNull();
  });
});
