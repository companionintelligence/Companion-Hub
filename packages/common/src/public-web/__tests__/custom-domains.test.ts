import { describe, expect, it } from 'vitest';
import { indexCustomDomainsByTarget, parseTunnelCustomDomains, selectCustomDomain } from '../custom-domains';

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
