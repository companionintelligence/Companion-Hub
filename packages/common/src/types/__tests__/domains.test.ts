import { describe, expect, it } from 'vitest';

import { selectOfferedDomains, type AvailableDomain } from '../domains';

function domain(name: string, offered?: boolean): AvailableDomain {
  return { id: name, domain: name, isDefault: false, offered };
}

describe('selectOfferedDomains', () => {
  it('keeps long brand suffixes and .pw, and hides ci.computer', () => {
    expect(
      selectOfferedDomains([domain('companionintelligence.com', true), domain('ci3.pw', true), domain('ci.computer', false)]).map(
        (entry) => entry.domain,
      ),
    ).toEqual(['companionintelligence.com', 'ci3.pw']);
  });

  it('keeps a grandfathered current suffix even when offered is false', () => {
    expect(selectOfferedDomains([domain('ci.computer', false), domain('ci3.pw', true)], 'ci.computer').map((entry) => entry.domain)).toEqual([
      'ci.computer',
      'ci3.pw',
    ]);
  });

  it('hides ci.computer when an older Portal omits offered', () => {
    expect(selectOfferedDomains([domain('companionintelligence.com'), domain('ci.computer')]).map((entry) => entry.domain)).toEqual([
      'companionintelligence.com',
    ]);
  });
});
