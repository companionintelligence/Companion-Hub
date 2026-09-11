import { describe, expect, it } from 'vitest';
import { type CustomDomainState, requestsCustomDomainChange } from '../custom-domain-authority';

const serving = (domain: string, overrides: Partial<CustomDomainState> = {}): CustomDomainState => ({
  intent: domain,
  bound: domain,
  takeover: false,
  wantedElsewhere: false,
  ...overrides,
});
const none: CustomDomainState = { intent: null, bound: null, takeover: false, wantedElsewhere: false };
/** Bound by CI-Cloud with no choice recorded on this Hub. */
const boundOnly = (domain: string, overrides: Partial<CustomDomainState> = {}): CustomDomainState => ({ ...none, bound: domain, ...overrides });

describe('requestsCustomDomainChange (R2-HUBDOMAINS-1)', () => {
  it.each([
    ['no customDomain field', {}, serving('shop.acme.com')],
    ['a takeover with no customDomain beside it', { customDomainTakeover: true }, serving('shop.acme.com')],
    ['the domain already asked for and served, re-submitted by the dialog', { customDomain: 'shop.acme.com' }, serving('shop.acme.com')],
    ['the same domain in another case', { customDomain: 'Shop.Acme.com' }, serving('shop.acme.com')],
    ['the domain CI-Cloud bound with no intent recorded', { customDomain: 'shop.acme.com' }, boundOnly('shop.acme.com')],
    ['the platform address on an app with no domain', { customDomain: '' }, none],
    [
      'a takeover answer already on record',
      { customDomain: 'shop.acme.com', customDomainTakeover: true },
      serving('shop.acme.com', { takeover: true }),
    ],
    [
      'a pending choice re-submitted with its takeover',
      { customDomain: 'shop.acme.com', customDomainTakeover: true },
      serving('shop.acme.com', { bound: 'old.acme.com', takeover: true }),
    ],
    ['a fresh install on the platform address', { customDomain: '' }, null],
    ['a non-string customDomain', { customDomain: 42 }, none],
    ['the platform address on an app whose columns hold blanks, not nulls', { customDomain: '' }, { ...none, intent: '', bound: '  ' }],
  ])('is not a change: %s', (_label, form, state) => {
    expect(requestsCustomDomainChange(form, state)).toBe(false);
  });

  it.each([
    ['asking for a different domain', { customDomain: 'other.acme.com' }, serving('shop.acme.com')],
    ['asking for a domain on an app with none', { customDomain: 'shop.acme.com' }, none],
    ['giving up the domain it serves', { customDomain: '' }, serving('shop.acme.com')],
    ['giving up a domain CI-Cloud bound with no intent', { customDomain: '' }, boundOnly('shop.acme.com')],
    ['dropping a pending intent', { customDomain: '' }, { ...none, intent: 'shop.acme.com' }],
    ['confirming a takeover not on record', { customDomain: 'shop.acme.com', customDomainTakeover: true }, serving('shop.acme.com')],
    [
      'withdrawing a takeover on record',
      { customDomain: 'shop.acme.com', customDomainTakeover: false },
      serving('shop.acme.com', { takeover: true }),
    ],
    ['withdrawing a takeover on record by leaving the answer out', { customDomain: 'shop.acme.com' }, serving('shop.acme.com', { takeover: true })],
    [
      'picking the domain it serves while it waits for another',
      { customDomain: 'old.acme.com' },
      serving('shop.acme.com', { bound: 'old.acme.com' }),
    ],
    [
      're-submitting its binding while another app waits for that domain',
      { customDomain: 'shop.acme.com' },
      boundOnly('shop.acme.com', { wantedElsewhere: true }),
    ],
    [
      're-submitting its own choice while another app holds the same one',
      { customDomain: 'shop.acme.com' },
      serving('shop.acme.com', { wantedElsewhere: true }),
    ],
    [
      'confirming a takeover of the domain CI-Cloud already bound it to',
      { customDomain: 'shop.acme.com', customDomainTakeover: true },
      boundOnly('shop.acme.com'),
    ],
    ['a fresh install asking for a domain', { customDomain: 'shop.acme.com' }, null],
  ])('is a change: %s', (_label, form, state) => {
    expect(requestsCustomDomainChange(form, state)).toBe(true);
  });
});
