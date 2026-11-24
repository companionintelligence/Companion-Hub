/**
 * The three guards in front of the DID routes, one at a time. Whether Nest runs them, in which order, and
 * what a client then reads is `did-auth.http.test.ts`; this file is the table of what each one decides.
 */
import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import express from 'express';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { absentRoute, DidAuthFlagGuard, DidAuthJsonGuard, DidAuthSameOriginGuard, originNamesAnotherHost } from '../did-auth.guard';
import { DID_AUTH_FLAG } from '../did-auth.service';

/**
 * A request with Express's own methods (`is`, `get`), so the guards run against the real content-type
 * matching and not a fake of it. `is` answers `null` for a request without a body, so a body is declared
 * the way a client declares one, by `Content-Length`.
 */
function request(init: { headers?: Record<string, string>; method?: string; originalUrl?: string; url?: string; body?: boolean } = {}): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== false && !('content-length' in headers) && !('transfer-encoding' in headers)) {
    headers['content-length'] = '2';
  }

  return Object.assign(Object.create(express.request), {
    headers,
    method: init.method ?? 'POST',
    originalUrl: init.originalUrl ?? '/api/auth/did/link',
    url: init.url ?? init.originalUrl ?? '/api/auth/did/link',
  }) as Request;
}
const context = (r: Request) => ({ switchToHttp: () => ({ getRequest: () => r }) }) as unknown as ExecutionContext;

function refusalOf(act: () => unknown): { status: number; message: string } {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(TranslatableError);

    return { status: (error as TranslatableError).getStatus(), message: ((error as TranslatableError).getResponse() as { message: string }).message };
  }
  throw new Error('expected the guard to refuse');
}

describe('DidAuthFlagGuard', () => {
  beforeEach(() => {
    delete process.env[DID_AUTH_FLAG];
  });
  afterEach(() => {
    delete process.env[DID_AUTH_FLAG];
  });

  const guard = new DidAuthFlagGuard();

  it('lets a request through only when the environment says exactly "true"', () => {
    process.env[DID_AUTH_FLAG] = 'true';

    expect(guard.canActivate(context(request()))).toBe(true);
  });

  it.each([[undefined], ['1'], ['TRUE'], ['True'], ['yes'], ['on'], ['false'], [''], [' true'], ['true ']])(
    'answers 404 when the flag is %j',
    (value) => {
      if (value !== undefined) {
        process.env[DID_AUTH_FLAG] = value;
      }

      expect(() => guard.canActivate(context(request()))).toThrow(NotFoundException);
    },
  );

  it('is the variable the documentation tells an operator to set, CI_HUB_DID_AUTH, typed here as an operator types it', () => {
    process.env.CI_HUB_DID_AUTH = 'true';

    expect(guard.canActivate(context(request()))).toBe(true);
    delete process.env.CI_HUB_DID_AUTH;
    expect(() => guard.canActivate(context(request()))).toThrow(NotFoundException);
  });

  it('reads the environment on every call: a change made inside the process is seen, which a running Hub never makes', () => {
    const ctx = context(request());
    process.env[DID_AUTH_FLAG] = 'true';
    expect(guard.canActivate(ctx)).toBe(true);

    delete process.env[DID_AUTH_FLAG];
    expect(() => guard.canActivate(ctx)).toThrow(NotFoundException);
  });

  it('answers with the not-found Nest gives a path no route claims: its message, and the path below the prefix', () => {
    const r = request({ method: 'GET', originalUrl: '/api/auth/did/links?x=1' });

    let thrown: unknown;
    try {
      guard.canActivate(context(r));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getResponse()).toEqual({
      message: 'Cannot GET /api/auth/did/links?x=1',
      error: 'Not Found',
      statusCode: 404,
    });
    expect(r.url).toBe('/auth/did/links?x=1');
  });
});

describe('absentRoute', () => {
  it('keeps the case a client wrote, and the query string, after the prefix', () => {
    const r = request({ method: 'POST', originalUrl: '/API/Auth/DID/challenge?a=b' });

    const error = absentRoute(r);

    expect(error.message).toBe('Cannot POST /API/Auth/DID/challenge?a=b');
    expect(r.url).toBe('/Auth/DID/challenge?a=b');
  });

  it.each([
    ['http://hub.example.test/api/auth/did/links', 'http://hub.example.test/auth/did/links'],
    ['https://hub.example.test:8443/api/auth/did/links?x=1', 'https://hub.example.test:8443/auth/did/links?x=1'],
    ['HTTP://HUB.EXAMPLE.TEST/API/Auth/DID/links', 'HTTP://HUB.EXAMPLE.TEST/Auth/DID/links'],
    [
      'http://user@hub.example.test/api/auth/did/links?next=http://evil.example/',
      'http://user@hub.example.test/auth/did/links?next=http://evil.example/',
    ],
  ])('keeps the scheme and host of the absolute-form target %s, as Express does when it strips a mount', (originalUrl, expected) => {
    const r = request({ originalUrl, url: originalUrl });

    absentRoute(r);

    expect(r.url).toBe(expected);
  });

  it('builds the path from the url Express restored, and the message from the raw target: a backslash in an absolute-form target is a slash to the router', () => {
    const r = request({ method: 'GET', originalUrl: 'http://h/api\\auth\\did\\links', url: 'http://h/api/auth/did/links' });

    const error = absentRoute(r);

    expect(r.url).toBe('http://h/auth/did/links');
    expect(error.message).toBe('Cannot GET http://h/api\\auth\\did\\links');
  });

  it('takes a backslash at the end of an absolute-form target the same way', () => {
    const r = request({ method: 'POST', originalUrl: 'http://h/api/auth/did/link\\', url: 'http://h/api/auth/did/link/' });

    absentRoute(r);

    expect(r.url).toBe('http://h/auth/did/link/');
  });

  it('keeps the scheme of a target with an empty host: the host ends where the path starts', () => {
    const r = request({ originalUrl: 'http:///api/auth/did/links', url: 'http:///api/auth/did/links' });

    absentRoute(r);

    expect(r.url).toBe('http:///auth/did/links');
  });

  it('looks for a scheme only before the query, as the router does, even in a target that is not origin-form', () => {
    // Such a target never reaches a DID route (it does not start with "/"), but the router's rule is what the 404 mirrors.
    const r = request({ originalUrl: 'x?next=http://evil.example/auth/did/links', url: 'x?next=http://evil.example/auth/did/links' });

    absentRoute(r);

    expect(r.url).toBe('/auth/did/links');
  });

  it('does not take a URL in the query of an ordinary target for a scheme and host', () => {
    const r = request({ originalUrl: '/api/auth/did/links?next=http://evil.example/auth/did/links' });

    absentRoute(r);

    expect(r.url).toBe('/auth/did/links?next=http://evil.example/auth/did/links');
  });

  it('leaves the url alone when the route is not under a prefix, or is not a DID route at all', () => {
    const bare = request({ originalUrl: '/auth/did/links', url: '/auth/did/links' });
    absentRoute(bare);
    expect(bare.url).toBe('/auth/did/links');

    const other = request({ originalUrl: '/api/other', url: '/api/other' });
    absentRoute(other);
    expect(other.url).toBe('/api/other');

    const bareHost = request({ originalUrl: 'http://hub.example.test', url: 'http://hub.example.test' });
    absentRoute(bareHost);
    expect(bareHost.url).toBe('http://hub.example.test');

    // The search starts after the scheme and host: the `//auth` of this target is not the start of `/auth/did/`.
    const hostNamedAuth = request({ originalUrl: 'http://auth/did/links', url: 'http://auth/did/links' });
    absentRoute(hostNamedAuth);
    expect(hostNamedAuth.url).toBe('http://auth/did/links');
  });
});

describe('DidAuthJsonGuard', () => {
  const guard = new DidAuthJsonGuard();

  it.each([['application/json'], ['application/json; charset=utf-8'], ['application/json;charset=UTF-8'], ['APPLICATION/JSON']])(
    'lets a %s body through',
    (type) => {
      expect(guard.canActivate(context(request({ headers: { 'content-type': type } })))).toBe(true);
    },
  );

  it.each([
    ['a form post', 'application/x-www-form-urlencoded'],
    ['a text/plain post', 'text/plain'],
    ['text/plain with a charset', 'text/plain;charset=UTF-8'],
    ['a multipart form', 'multipart/form-data; boundary=x'],
    ['a JSON-ish type that is not application/json', 'application/ld+json'],
    ['another +json type', 'application/vnd.api+json'],
    ['a prefix of the type', 'application/jsonp'],
    ['octet-stream', 'application/octet-stream'],
  ])('refuses %s with a 415 and a code to read', (_name, type) => {
    expect(refusalOf(() => guard.canActivate(context(request({ headers: { 'content-type': type } }))))).toEqual({
      status: 415,
      message: 'AUTH_ERROR_DID_JSON_REQUIRED',
    });
  });

  it('refuses a body that declares no type', () => {
    expect(refusalOf(() => guard.canActivate(context(request())))).toMatchObject({ status: 415 });
  });

  it('refuses a request that says it is JSON but has no body at all', () => {
    // `is` answers null for no body; a client sends `Content-Length: 0` or a body to be read as JSON.
    expect(refusalOf(() => guard.canActivate(context(request({ headers: { 'content-type': 'application/json' }, body: false }))))).toMatchObject({
      status: 415,
    });
  });
});

describe('originNamesAnotherHost', () => {
  const asked = (headers: Record<string, string | string[]>) => originNamesAnotherHost(request({ headers: headers as Record<string, string> }));

  it('says nothing about a request that carries no Origin: a script or the CLI is no browser', () => {
    expect(asked({})).toBe(false);
    expect(asked({ host: 'hub.example.test' })).toBe(false);
  });

  it.each([
    ['its own origin over https', { origin: 'https://hub.example.test', host: 'hub.example.test' }],
    ['its own origin with the port written out', { origin: 'https://hub.example.test:443', host: 'hub.example.test' }],
    ['its own origin with the port on the other side', { origin: 'https://hub.example.test', host: 'hub.example.test:443' }],
    ['its own origin over http with the default port', { origin: 'http://hub.example.test:80', host: 'hub.example.test' }],
    ['an uppercase host', { origin: 'https://HUB.example.test', host: 'hub.example.test' }],
    ['a LAN address and port', { origin: 'http://192.168.1.10:3000', host: '192.168.1.10:3000' }],
    ['a loopback name and port', { origin: 'http://localhost:5002', host: 'localhost:5002' }],
    ['an IPv6 literal', { origin: 'http://[::1]:3000', host: '[::1]:3000' }],
    [
      'the host a proxy forwarded, not the one it rewrote',
      { origin: 'https://hub.example.test', host: 'backend:3000', 'x-forwarded-host': 'hub.example.test' },
    ],
    [
      'the first of several forwarded hosts',
      { origin: 'https://hub.example.test', host: 'backend:3000', 'x-forwarded-host': 'hub.example.test, edge.example' },
    ],
  ])('accepts %s', (_name, headers) => {
    expect(asked(headers)).toBe(false);
  });

  it.each([
    ['another host', { origin: 'https://evil.example', host: 'hub.example.test' }],
    ['a sibling host', { origin: 'https://other.example.test', host: 'hub.example.test' }],
    ['a child host', { origin: 'https://evil.hub.example.test', host: 'hub.example.test' }],
    ['a host that merely ends in ours', { origin: 'https://hub.example.test.evil.example', host: 'hub.example.test' }],
    ['a host that merely starts with ours', { origin: 'https://xhub.example.test', host: 'hub.example.test' }],
    ['the same host on another port', { origin: 'https://hub.example.test:8443', host: 'hub.example.test' }],
    ['a sibling port on a plain-http LAN address', { origin: 'http://192.168.1.10:3001', host: '192.168.1.10:3000' }],
    ['another LAN address', { origin: 'http://192.168.1.11:3000', host: '192.168.1.10:3000' }],
    ['the same host over the other scheme with another default port', { origin: 'http://hub.example.test', host: 'hub.example.test:443' }],
    ['the desktop shell', { origin: 'tauri://localhost', host: 'localhost:3000' }],
    [
      'the host the proxy forwarded, not the one it rewrote',
      { origin: 'https://backend:3000', host: 'backend:3000', 'x-forwarded-host': 'hub.example.test' },
    ],
    ['a sandboxed frame', { origin: 'null', host: 'hub.example.test' }],
    ['an empty Origin', { origin: '', host: 'hub.example.test' }],
    ['something that is not a URL', { origin: 'not a url', host: 'hub.example.test' }],
    ['two origins joined by a repeated header', { origin: 'https://hub.example.test, https://evil.example', host: 'hub.example.test' }],
    ['an Origin and no host at all to compare it with', { origin: 'https://hub.example.test' }],
    ['a host that is not a host', { origin: 'https://hub.example.test', host: 'hub example' }],
  ])('refuses %s', (_name, headers) => {
    expect(asked(headers)).toBe(true);
  });

  it('refuses an Origin that arrives as a list, whatever it holds', () => {
    expect(asked({ origin: ['https://hub.example.test', 'https://hub.example.test'], host: 'hub.example.test' })).toBe(true);
  });
});

describe('DidAuthSameOriginGuard', () => {
  const guard = new DidAuthSameOriginGuard();
  const refused = (headers: Record<string, string>) => refusalOf(() => guard.canActivate(context(request({ headers }))));

  it.each([
    ['a client that sends no browser headers (curl, the CLI)', {}],
    ['the Hub’s own page: same-origin fetch metadata', { 'sec-fetch-site': 'same-origin' }],
    ['a user-initiated request: Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
    ['the Hub’s own page: its Origin', { origin: 'https://hub.example.test', host: 'hub.example.test' }],
    [
      'both signals agreeing it is the Hub’s own page',
      { 'sec-fetch-site': 'same-origin', origin: 'https://hub.example.test', host: 'hub.example.test' },
    ],
    ['a plain-http LAN page of the Hub itself (no fetch metadata is sent there)', { origin: 'http://192.168.1.10:3000', host: '192.168.1.10:3000' }],
  ])('lets through %s', (_name, headers) => {
    expect(guard.canActivate(context(request({ headers })))).toBe(true);
  });

  it.each([['cross-site'], ['same-site']])('refuses a browser that says another site sent it (Sec-Fetch-Site: %s)', (site) => {
    expect(refused({ 'sec-fetch-site': site })).toEqual({ status: 403, message: 'AUTH_ERROR_DID_CROSS_SITE_REQUEST' });
  });

  it('refuses a foreign Origin on a plain-http Hub, where the browser sends no Sec-Fetch-Site at all', () => {
    expect(refused({ origin: 'http://192.168.1.10:3001', host: '192.168.1.10:3000' })).toEqual({
      status: 403,
      message: 'AUTH_ERROR_DID_CROSS_SITE_REQUEST',
    });
  });

  it('refuses when either signal says another site, even if the other says the Hub’s own', () => {
    expect(refused({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example', host: 'hub.example.test' })).toMatchObject({ status: 403 });
    expect(refused({ 'sec-fetch-site': 'cross-site', origin: 'https://hub.example.test', host: 'hub.example.test' })).toMatchObject({ status: 403 });
  });

  it('refuses the desktop shell’s own origin until a screen for these routes exists to be tested against it', () => {
    expect(refused({ origin: 'tauri://localhost', host: 'localhost:3000' })).toMatchObject({ status: 403 });
  });
});
