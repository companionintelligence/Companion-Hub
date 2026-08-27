import { describe, expect, it } from 'vitest';
import { indexCustomDomainsByTarget, parseTunnelCustomDomains } from '../custom-domains';

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
      { id: '', domain: 'blank-id.acme.com', targetHostname: 'app-hub-acme.example.com' },
      { id: 'cd_3', domain: '   ', targetHostname: 'app-hub-acme.example.com' },
      { id: 'cd_4', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' },
    ]);

    expect(parsed?.entries).toEqual([{ id: 'cd_4', domain: 'good.acme.com', targetHostname: 'app-hub-acme.example.com' }]);
    expect(parsed?.dropped).toBe(6);
  });

  it('treats a non-array value as delivered-but-broken, not as absent', () => {
    // The field WAS sent, so the Portal is new enough to speak custom domains.
    // Reporting it as absent would freeze whatever bindings the Hub already has.
    expect(parseTunnelCustomDomains({ domain: 'comfy.acme.com' })).toEqual({ entries: [], dropped: 1 });
  });
});

describe('indexCustomDomainsByTarget', () => {
  it('indexes by the platform hostname the domain aliases', () => {
    const index = indexCustomDomainsByTarget([
      { id: 'cd_1', domain: 'comfy.acme.com', targetHostname: 'comfyui-hub-acme.example.com' },
      { id: 'cd_2', domain: 'chat.acme.com', targetHostname: 'openwebui-hub-acme.example.com' },
    ]);

    expect(index.get('comfyui-hub-acme.example.com')).toBe('comfy.acme.com');
    expect(index.get('openwebui-hub-acme.example.com')).toBe('chat.acme.com');
    expect(index.get('nothing-hub-acme.example.com')).toBeUndefined();
  });

  it('picks the same winner every sync when two domains share one target', () => {
    const target = 'comfyui-hub-acme.example.com';
    const forward = indexCustomDomainsByTarget([
      { id: 'cd_1', domain: 'zzz.acme.com', targetHostname: target },
      { id: 'cd_2', domain: 'aaa.acme.com', targetHostname: target },
    ]);
    // Same set, opposite order — a hostname that flipped with CI-Cloud's row
    // order would ask for a restart on every heartbeat.
    const reversed = indexCustomDomainsByTarget([
      { id: 'cd_2', domain: 'aaa.acme.com', targetHostname: target },
      { id: 'cd_1', domain: 'zzz.acme.com', targetHostname: target },
    ]);

    expect(forward.get(target)).toBe('aaa.acme.com');
    expect(reversed.get(target)).toBe('aaa.acme.com');
  });
});
