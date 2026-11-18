import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossSiteRequestGuard, isRefusedCrossSiteRequest } from '../cross-site-request';

const request = (method: string, headers: Record<string, string> = {}) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { method, get: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
};

describe('isRefusedCrossSiteRequest', () => {
  const saved = { domain: process.env.DOMAIN, local: process.env.LOCAL_DOMAIN };

  beforeEach(() => {
    process.env.DOMAIN = 'hub.example.com';
    delete process.env.LOCAL_DOMAIN;
  });

  afterEach(() => {
    process.env.DOMAIN = saved.domain;
    if (saved.local === undefined) delete process.env.LOCAL_DOMAIN;
    else process.env.LOCAL_DOMAIN = saved.local;
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('never refuses a %s', (method) => {
    expect(isRefusedCrossSiteRequest(request(method, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))).toBe(false);
  });

  /*
   * The 2026-11-17 audit: an unpaired Hub's `/registration/pair` is unauthenticated by design, the
   * Hub parses urlencoded bodies, and a plain form needs no preflight — so any page could pair it.
   * An app on another port of the Hub's host is the same SITE, which `SameSite=Lax` lets through.
   */
  it.each([
    ['a page on another site', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ['an app on another port of the Hub’s host', { 'sec-fetch-site': 'same-site', origin: 'http://192.168.1.5:8096' }],
    ['a sandboxed frame (null Origin)', { 'sec-fetch-site': 'cross-site', origin: 'null' }],
    ['a cross-site request with no Origin', { 'sec-fetch-site': 'cross-site' }],
    ['an older browser posting from another host', { origin: 'https://evil.example', host: 'hub.example.com' }],
  ])('refuses a POST from %s', (_label, headers) => {
    expect(isRefusedCrossSiteRequest(request('POST', headers))).toBe(true);
  });

  it.each([
    ['the Hub page itself', { 'sec-fetch-site': 'same-origin', origin: 'http://192.168.1.5:5002' }],
    ['a typed or bookmarked request', { 'sec-fetch-site': 'none' }],
    ['the desktop shell (an allowlisted origin)', { 'sec-fetch-site': 'cross-site', origin: 'tauri://localhost' }],
    ['the Hub’s own public name', { 'sec-fetch-site': 'same-site', origin: 'https://hub.example.com' }],
    ['an older browser on the Hub’s own host', { origin: 'http://192.168.1.5:5002', host: '192.168.1.5:5002' }],
    ['an older browser behind the proxy', { origin: 'https://hub.example.com', 'x-forwarded-host': 'hub.example.com', host: 'ci-hub:5002' }],
    ['a server-to-server caller (no browser headers)', {}],
  ])('lets a POST from %s through', (_label, headers) => {
    expect(isRefusedCrossSiteRequest(request('POST', headers))).toBe(false);
  });

  it.each([
    ['Authorization', { authorization: 'Bearer key' }],
    ['X-API-Key', { 'x-api-key': 'key' }],
    ['X-CI-Hub-Session', { 'x-ci-hub-session': 'sid.sig' }],
  ])('leaves a request carrying its own credential (%s) alone: a forged one would need the secret', (_label, credential) => {
    expect(isRefusedCrossSiteRequest(request('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', ...credential }))).toBe(false);
  });
});

describe('crossSiteRequestGuard', () => {
  it('answers 403 and stops a refused request', () => {
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as never;
    const next = vi.fn();

    crossSiteRequestGuard(request('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ statusCode: 403, message: 'Cross-site request refused' });
  });

  it('passes anything else on', () => {
    const next = vi.fn();
    crossSiteRequestGuard(request('POST', { 'sec-fetch-site': 'same-origin' }), {} as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
