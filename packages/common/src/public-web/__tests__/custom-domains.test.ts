import { describe, expect, it } from 'vitest';
import { indexCustomDomainsByTarget, parseAvailableCustomDomains, parseTunnelCustomDomains, selectCustomDomain } from '../custom-domains';

describe('parseTunnelCustomDomains', () => {
  it('keeps "absent" and "empty" apart', () => {
    // The whole unbind path hangs on this: `undefined` is a CI-Cloud that does
    // not report custom domains at all, `[]` is one saying this device has none.
    expect(parseTunnelCustomDomains(undefined)).toBeUndefined();
    expect(parseTunnelCustomDomains(null)).toBeUndefined();
    expect(parseTunnelCustomDomains([])).toEqual({ entries: [], dropped: 0 });
  });

  it('accepts well-formed entries and lowercases the hostnames', () => {
    const parsed = parseTunnelCustomDomains([
      { id: 'cd_1', domain: 'Comfy.Acme.COM', targetHostname: 'ComfyUI-Hub-Core2-Acme.CompanionIntelligence.com' },
    ]);

    expect(parsed).toEqual({
      entries: [{ id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-hub-core2-acme.companionintelligence.com' }],
      dropped: 0,
    });
  });

  it('drops malformed entries rather than rejecting the whole array', () => {
    const parsed = parseTunnelCustomDomains([
      null,
      'not-an-object',
      { id: 'cd_1' },
      { id: 'cd_2', domain: 'ok.acme.com' },
      { id: '', domain: 'kept-despite-blank-id.acme.com', targetHostname: 'other-hub-acme.example.com' },
      { id: 'cd_3', domain: '   ', targetHostname: 'app-hub-acme.example.com' },
      { id: 'cd_4', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' },
    ]);

    expect(parsed?.entries).toEqual([
      { id: undefined, domain: 'kept-despite-blank-id.acme.com', targetHostname: 'other-hub-acme.example.com' },
      { id: 'cd_4', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' },
    ]);
    // `{ id: '' }` survives: the id is informational and must never gate a live
    // domain, so only the missing domain/target rows and the junk are dropped.
    expect(parsed?.dropped).toBe(5);
  });

  it('drops entries whose domain or target is not a hostname', () => {
    // These reach `https://${domain}` in an app's compose env, so a string that
    // is not a name would have the app signing OAuth redirects for an address
    // that cannot resolve. Dropping leaves it on the platform hostname, which works.
    const parsed = parseTunnelCustomDomains([
      { id: 'a', domain: 'comfy.acme.com/evil', targetHostname: 'app-hub-acme.example.com' },
      { id: 'b', domain: 'has space.acme.com', targetHostname: 'app-hub-acme.example.com' },
      { id: 'c', domain: 'localhost', targetHostname: 'app-hub-acme.example.com' },
      { id: 'd', domain: '-lead.acme.com', targetHostname: 'app-hub-acme.example.com' },
      { id: 'e', domain: 'https://comfy.acme.com', targetHostname: 'app-hub-acme.example.com' },
      { id: 'f', domain: `${'a'.repeat(64)}.acme.com`, targetHostname: 'app-hub-acme.example.com' },
      { id: 'g', domain: 'ok.acme.com', targetHostname: 'not a hostname' },
      { id: 'h', domain: 'ok.acme.com', targetHostname: 'app-hub-acme.example.com' },
    ]);

    expect(parsed?.entries).toEqual([{ id: 'h', domain: 'ok.acme.com', targetHostname: 'app-hub-acme.example.com' }]);
    expect(parsed?.dropped).toBe(7);
  });

  it('accepts the hostname shapes CI-Cloud itself accepts', () => {
    // Rejecting anything CI-Cloud let through would refuse to tell an app about a
    // domain that is already serving, so the rule must not be stricter than theirs.
    const parsed = parseTunnelCustomDomains([
      { id: 'apex', domain: 'acme.com', targetHostname: 'a-hub-acme.example.com' },
      { id: 'sub', domain: 'deep.sub.acme.co.uk', targetHostname: 'b-hub-acme.example.com' },
      { id: 'hyphen', domain: 'my-app-1.acme.com', targetHostname: 'c-hub-acme.example.com' },
      // A fully-qualified trailing dot is legal in a zone file; normalize, don't reject.
      { id: 'fqdn', domain: 'trailing.acme.com.', targetHostname: 'd-hub-acme.example.com' },
    ]);

    expect(parsed?.dropped).toBe(0);
    expect(parsed?.entries.map((entry) => entry.domain)).toEqual(['acme.com', 'deep.sub.acme.co.uk', 'my-app-1.acme.com', 'trailing.acme.com']);
  });

  it('treats a non-array value as delivered-but-broken, not as absent', () => {
    // The field WAS sent, but nothing in it could be read. "We could not parse
    // this" is not the same instruction as "this device has none" — reporting it
    // as an empty array would unbind every app on a custom hostname, fleet-wide,
    // on the strength of a response nobody understood.
    expect(parseTunnelCustomDomains({ domain: 'comfy.acme.com' })).toEqual({ entries: undefined, dropped: 1 });
    // Same for an array whose every row was junk (a renamed wire field).
    expect(parseTunnelCustomDomains([{ id: 'cd_1', domain: 'comfy.acme.com', target: 'app-hub-acme.example.com' }])).toEqual({
      entries: undefined,
      dropped: 1,
    });
    // An array that parsed cleanly to nothing is still a real "none".
    expect(parseTunnelCustomDomains([])).toEqual({ entries: [], dropped: 0 });
  });
});

describe('indexCustomDomainsByTarget', () => {
  it('indexes by the platform hostname the domain aliases', () => {
    const index = indexCustomDomainsByTarget([
      { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-hub-acme.example.com' },
      { id: 'cd_2', domain: 'chat.acme.com', targetHostname: 'openwebui-hub-acme.example.com' },
    ]);

    expect(index.get('comfyui-hub-acme.example.com')).toEqual(['comfy.acme.com']);
    expect(index.get('openwebui-hub-acme.example.com')).toEqual(['chat.acme.com']);
    expect(index.get('nothing-hub-acme.example.com')).toBeUndefined();
  });

  it("orders a target's domains the same way every sync", () => {
    const target = 'comfyui-hub-acme.example.com';
    const forward = indexCustomDomainsByTarget([
      { id: 'cd_1', domain: 'zzz.acme.com', targetHostname: target },
      { id: 'cd_2', domain: 'aaa.acme.com', targetHostname: target },
    ]);
    // Same set, opposite order — an order that flipped with CI-Cloud's rows would
    // ask for a restart on every heartbeat.
    const reversed = indexCustomDomainsByTarget([
      { id: 'cd_2', domain: 'aaa.acme.com', targetHostname: target },
      { id: 'cd_1', domain: 'zzz.acme.com', targetHostname: target },
    ]);

    expect(forward.get(target)).toEqual(['aaa.acme.com', 'zzz.acme.com']);
    expect(reversed.get(target)).toEqual(['aaa.acme.com', 'zzz.acme.com']);
  });

  it('drops a domain that is reported against two different targets', () => {
    // A rebind caught mid-flight. The Hub cannot tell which app Cloudflare is
    // actually routing, and binding both would have the app that is NOT routed
    // emit the hostname and sign redirects landing users in a sibling app.
    const index = indexCustomDomainsByTarget([
      { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-hub-acme.example.com' },
      { id: 'cd_2', domain: 'comfy.acme.com', targetHostname: 'openwebui-hub-acme.example.com' },
      { id: 'cd_3', domain: 'chat.acme.com', targetHostname: 'openwebui-hub-acme.example.com' },
    ]);

    expect(index.get('comfyui-hub-acme.example.com')).toBeUndefined();
    expect(index.get('openwebui-hub-acme.example.com')).toEqual(['chat.acme.com']);
  });
});

describe('selectCustomDomain', () => {
  it('keeps the domain the app is already serving on', () => {
    // Deterministic is not enough. An app bound to zzz.acme.com whose customer
    // adds an apex alias must not be moved off the hostname its OAuth client is
    // registered against just because the new name sorts first.
    expect(selectCustomDomain(['aaa.acme.com', 'zzz.acme.com'], 'zzz.acme.com')).toBe('zzz.acme.com');
  });

  it('takes the first delivered domain when nothing is bound yet', () => {
    expect(selectCustomDomain(['aaa.acme.com', 'zzz.acme.com'], null)).toBe('aaa.acme.com');
  });

  it('moves on when the bound domain stops being delivered', () => {
    expect(selectCustomDomain(['aaa.acme.com'], 'zzz.acme.com')).toBe('aaa.acme.com');
  });

  it('unbinds when nothing is delivered for the target', () => {
    expect(selectCustomDomain(undefined, 'zzz.acme.com')).toBeNull();
    expect(selectCustomDomain([], 'zzz.acme.com')).toBeNull();
  });
});

describe('parseAvailableCustomDomains', () => {
  const listed = (overrides: Record<string, unknown> = {}) => ({
    id: 'cd_1',
    domain: 'comfy.acme.com',
    state: 'parked',
    bindable: true,
    targetHostname: null,
    boundAppSlug: null,
    boundElsewhere: false,
    ...overrides,
  });

  it('reads a well-formed listing', () => {
    expect(parseAvailableCustomDomains([listed()])).toEqual([
      {
        id: 'cd_1',
        domain: 'comfy.acme.com',
        state: 'parked',
        bindable: true,
        targetHostname: null,
        boundAppSlug: null,
        boundElsewhere: false,
      },
    ]);
  });

  it('reports an unreadable payload as unanswered, not as none', () => {
    /*
     * ⚠ THE DISTINCTION THE PICKER IS BUILT ON. "You have no custom domains,
     * connect one in the portal" is a sentence; saying it because the request
     * failed is the silence this feature exists to end.
     */
    expect(parseAvailableCustomDomains(undefined)).toBeUndefined();
    expect(parseAvailableCustomDomains({ domains: [] })).toBeUndefined();
    expect(parseAvailableCustomDomains('nope')).toBeUndefined();
  });

  it('reports a genuinely empty listing as empty', () => {
    expect(parseAvailableCustomDomains([])).toEqual([]);
  });

  it('drops entries it cannot use rather than the whole listing', () => {
    const domains = parseAvailableCustomDomains([
      null,
      listed({ id: '' }),
      listed({ domain: 'not a hostname' }),
      listed({ id: 'cd_ok', domain: 'ok.acme.com' }),
    ]);

    expect(domains?.map((entry) => entry.domain)).toEqual(['ok.acme.com']);
  });

  it('reads the states CI-Cloud reports for a certificate still issuing, and for drift', () => {
    // Ownership and TLS are gated independently by Cloudflare, so `securing` is
    // a routine state rather than an edge case — and both are BINDABLE, because
    // a certificate finishes on its own and drift is a fact about the customer's
    // DNS rather than about our permission to point the row somewhere.
    const domains = parseAvailableCustomDomains([
      listed({ id: 'cd_1', domain: 'securing.acme.com', state: 'securing' }),
      listed({ id: 'cd_2', domain: 'drifted.acme.com', state: 'drifted' }),
    ]);

    expect(domains).toEqual([
      expect.objectContaining({ domain: 'securing.acme.com', state: 'securing', bindable: true }),
      expect.objectContaining({ domain: 'drifted.acme.com', state: 'drifted', bindable: true }),
    ]);
  });

  it('keeps a domain whose state this build has never heard of', () => {
    /*
     * ⚠ THE FAILURE THIS PICKER EXISTS TO END, ARRIVING BY THE BACK DOOR. A Hub
     * is older than the Portal it talks to for most of its life, so meeting a
     * new state is the ordinary case. Dropping the row made a connected,
     * bindable domain silently absent — "the Hub cannot see my domain" — and,
     * because the bind pass reads a successful listing as the organization's
     * full set, it would also have cleared that domain's install-time choice.
     *
     * The state is a label; `bindable` is the gate.
     */
    const domains = parseAvailableCustomDomains([listed({ state: 'quiesced' })]);

    expect(domains).toEqual([expect.objectContaining({ domain: 'comfy.acme.com', state: 'unknown', bindable: true })]);
  });

  it('reports a listing whose every row was junk as unanswered, not as empty', () => {
    /*
     * ⚠ DESTRUCTIVE IF COLLAPSED. The bind pass reads a successful listing as the
     * organization's FULL set and clears every intent naming a domain absent from
     * it — so a payload whose shape drifted (an `id` that arrives as a number,
     * which CI-Cloud's sibling domain endpoint already does) would wipe every
     * custom-domain choice on the Hub in one pass.
     *
     * A NEW `state` is deliberately NOT such a drift any more: it keeps the row
     * as `unknown`, because a Hub meeting a newer Portal must not lose domains.
     */
    expect(parseAvailableCustomDomains([listed({ id: 41 })])).toBeUndefined();
    expect(parseAvailableCustomDomains([listed({ domain: 'not a hostname' })])).toBeUndefined();
    expect(parseAvailableCustomDomains([null, 'nope'])).toBeUndefined();
  });

  it('keeps a domain whose target CI-Cloud reported as junk, without the junk', () => {
    // Dropping the row would read as "the organization no longer holds it" and
    // clear the choice; keeping an unusable target would make the "already points
    // here" check miss forever and re-bind on every sync.
    const domains = parseAvailableCustomDomains([listed({ targetHostname: 'not a hostname' })]);

    expect(domains).toHaveLength(1);
    expect(domains?.[0]?.targetHostname).toBeNull();
  });

  it('defaults bindable to false when the answer is missing', () => {
    // Offering a domain the server would refuse spends a person's attention on
    // a choice that cannot be honoured.
    expect(parseAvailableCustomDomains([listed({ bindable: undefined })])?.[0]?.bindable).toBe(false);
    expect(parseAvailableCustomDomains([listed({ bindable: 'yes' })])?.[0]?.bindable).toBe(false);
  });

  it('normalizes hostnames so both sides compare equal', () => {
    const domains = parseAvailableCustomDomains([listed({ domain: 'Comfy.Acme.Com.', targetHostname: 'ComfyUI-Core2-Acme.Example.Com' })]);

    expect(domains?.[0]).toMatchObject({
      domain: 'comfy.acme.com',
      targetHostname: 'comfyui-core2-acme.example.com',
    });
  });
});
