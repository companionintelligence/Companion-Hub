import { describe, expect, it } from 'vitest';
import type { PublicDnsFailure } from '@/modules/cloudflare/cloudflare-client.service';
import { moveStoredPublicDomain, readServedHostname, resolveMovedPublicDomainRoot } from '../public-domain-move';

/** The entry CI-Portal#841 sends for an app it moved, verbatim. */
const moved841 = (overrides: Partial<PublicDnsFailure> = {}): PublicDnsFailure => ({
  app: 'n8n',
  hostname: 'n8n-core-2-bill-co.companionintelligence.com',
  reason: 'zone_unreachable',
  message:
    'This environment cannot write DNS in the zone for companionintelligence.com, so n8n-core-2-bill-co.companionintelligence.com ' +
    'was not published; the app is served at n8n-core-2-bill-co.ci.computer instead',
  ...overrides,
});

describe('readServedHostname', () => {
  it('reads the served hostname from the message CI-Portal#841 sends', () => {
    expect(readServedHostname(moved841())).toBe('n8n-core-2-bill-co.ci.computer');
  });

  it('prefers the explicit servedHostname field over the message', () => {
    expect(readServedHostname(moved841({ servedHostname: 'n8n-core-2-bill-co.example.org' }))).toBe('n8n-core-2-bill-co.example.org');
  });

  it('reads the field when there is no message at all', () => {
    expect(readServedHostname(moved841({ message: undefined, servedHostname: 'N8N-Core-2-Bill-Co.CI.Computer.' }))).toBe(
      'n8n-core-2-bill-co.ci.computer',
    );
  });

  it('finds nothing in a zone_unreachable from a Portal older than #841, which moved nothing', () => {
    // Before #841 the app was refused, not moved, and its message named no other hostname.
    expect(readServedHostname(moved841({ message: 'Cloudflare record lookup failed: 403 Authentication error' }))).toBeNull();
  });

  it.each(['release_pending', 'conflict', 'api_error'] as const)('never reads a %s entry as a move, even one carrying a hostname', (reason) => {
    // `release_pending` keeps the app on its OLD address; adopting that would undo the change the Hub asked for.
    expect(readServedHostname(moved841({ reason, servedHostname: 'n8n-core-2-bill-co.ci.computer' }))).toBeNull();
    expect(readServedHostname(moved841({ reason }))).toBeNull();
  });

  it.each([
    ['a bare label', 'localhost'],
    ['a URL', 'https://n8n.ci.computer/'],
    ['an address with a port', 'n8n.ci.computer:8443'],
  ])('rejects %s', (_case, servedHostname) => {
    expect(readServedHostname(moved841({ servedHostname }))).toBeNull();
  });

  it('matches only the sentence #841 ends its message with', () => {
    expect(readServedHostname(moved841({ message: 'the app is served at n8n.ci.computer instead; and more' }))).toBeNull();
  });
});

describe('resolveMovedPublicDomainRoot', () => {
  const composed = { composedHostname: 'n8n-core-2-bill-co.companionintelligence.com', composedRoot: 'companionintelligence.com' };

  it('returns the root that makes the Hub compose the served hostname', () => {
    expect(resolveMovedPublicDomainRoot({ ...composed, servedHostname: 'n8n-core-2-bill-co.ci.computer' })).toBe('ci.computer');
  });

  it('refuses a served hostname with another prefix, which no domain choice can express', () => {
    expect(resolveMovedPublicDomainRoot({ ...composed, servedHostname: 'n8n-core-3-bill-co.ci.computer' })).toBeNull();
  });

  it('moves nothing when the served hostname is the one the Hub already composes', () => {
    expect(resolveMovedPublicDomainRoot({ ...composed, servedHostname: 'N8N-core-2-bill-co.companionintelligence.com' })).toBeNull();
  });

  it('refuses a root that is not a domain', () => {
    // A single label has no TLD: composing on it would give the app an address nothing resolves.
    expect(resolveMovedPublicDomainRoot({ ...composed, servedHostname: 'n8n-core-2-bill-co.local' })).toBeNull();
  });
});

describe('moveStoredPublicDomain', () => {
  const move = {
    publicDomain: 'ci.computer',
    fromUrl: 'https://n8n-core-2-bill-co.companionintelligence.com',
    toUrl: 'https://n8n-core-2-bill-co.ci.computer',
  };

  it('moves the public domain and every value that was the old public URL', () => {
    const moved = moveStoredPublicDomain(
      {
        publicDomain: 'companionintelligence.com',
        exposureMode: 'cloudflare',
        N8N_BASE_URL: 'https://n8n-core-2-bill-co.companionintelligence.com',
        WEBHOOK_URL: 'https://n8n-core-2-bill-co.companionintelligence.com/',
      },
      move,
    );

    expect(moved).toEqual({
      publicDomain: 'ci.computer',
      exposureMode: 'cloudflare',
      N8N_BASE_URL: 'https://n8n-core-2-bill-co.ci.computer',
      WEBHOOK_URL: 'https://n8n-core-2-bill-co.ci.computer/',
    });
  });

  it('leaves a value someone typed alone, even one on the old hostname', () => {
    const moved = moveStoredPublicDomain(
      {
        publicDomain: 'companionintelligence.com',
        N8N_BASE_URL: 'https://n8n.acme.com',
        WEBHOOK_URL: 'https://n8n-core-2-bill-co.companionintelligence.com/webhook',
        port: 5678,
      },
      move,
    );

    expect(moved).toEqual({
      publicDomain: 'ci.computer',
      N8N_BASE_URL: 'https://n8n.acme.com',
      WEBHOOK_URL: 'https://n8n-core-2-bill-co.companionintelligence.com/webhook',
      port: 5678,
    });
  });

  it('starts from an empty form when none was saved', () => {
    expect(moveStoredPublicDomain(null, move)).toEqual({ publicDomain: 'ci.computer' });
  });
});
