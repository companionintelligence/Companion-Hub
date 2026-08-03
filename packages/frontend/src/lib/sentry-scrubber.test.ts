import type { Breadcrumb, ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubBrowserEvent, scrubString, scrubUrl } from './sentry-scrubber';

const scrub = (event: unknown) => scrubBrowserEvent(event as ErrorEvent) as unknown as Record<string, any>;

describe('scrubString', () => {
  it('collapses home paths on every platform', () => {
    expect(scrubString('/Users/liam/notes')).toBe('~/notes');
    expect(scrubString('/home/ci/state')).toBe('~/state');
    // Windows must win over the macOS pattern, or a stranded `C:~/…` is left.
    expect(scrubString('C:\\Users\\liam\\AppData')).toBe('~\\AppData');
    expect(scrubString('C:/Users/liam/AppData')).toBe('~/AppData');
  });

  it('redacts credentials, including hyphenated api-key forms', () => {
    expect(scrubString('Authorization: Bearer abc123DEF')).not.toContain('abc123DEF');
    expect(scrubString('x-api-key: KEYVALUE123')).not.toContain('KEYVALUE123');
    expect(scrubString('tskey-auth-abc123')).not.toContain('abc123');
    expect(scrubString('postgres://ci:hunter2@db:5432/hub')).not.toContain('hunter2');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
    expect(scrubbed.length).toBeLessThan(9000);
  });
});

describe('scrubUrl', () => {
  it('strips query and fragment without touching the path', () => {
    expect(scrubUrl('https://hub.local/apps?q=private#frag')).toBe('https://hub.local/apps');
    expect(scrubUrl('/apps')).toBe('/apps');
  });
});

describe('scrubBrowserEvent', () => {
  it('strips the full page URL and referrer that httpContextIntegration attaches', () => {
    // httpContextIntegration sets request.url = window.location.href and
    // headers.Referer = document.referrer, unconditionally and with no
    // sendDefaultPii check.
    const result = scrub({
      request: {
        url: 'https://hub.local/apps?q=private-notes#section',
        headers: { Referer: 'https://hub.local/search?q=private-notes', 'User-Agent': 'Mozilla/5.0' },
        cookies: { 'ci-hub-session': 'abc' },
        data: { password: 'hunter2' },
        query_string: 'q=private-notes',
      },
    });

    expect(result.request.url).toBe('https://hub.local/apps');
    expect(result.request.headers.Referer).toBe('https://hub.local/search');
    expect(result.request.headers['User-Agent']).toBe('Mozilla/5.0');
    expect(result.request.cookies).toBeUndefined();
    expect(result.request.data).toBeUndefined();
    expect(result.request.query_string).toBeUndefined();
  });

  it('filters sensitive and identity keys in extra', () => {
    const result = scrub({
      extra: {
        'x-api-key': 'ci_hub_9f3a',
        signature: 'deadbeef',
        email: 'liam@example.com',
        response_body: 'failed at /Users/liam/notes',
        http_status: 500,
      },
    });

    expect(result.extra['x-api-key']).toBe('[Filtered]');
    expect(result.extra.signature).toBe('[Filtered]');
    expect(result.extra.email).toBe('[Filtered]');
    expect(result.extra.response_body).toBe('failed at ~/notes');
    expect(result.extra.http_status).toBe(500);
  });

  it('keeps user.id but drops other user identifiers', () => {
    const result = scrub({ user: { id: 'device-abc', ip_address: '203.0.113.42', email: 'liam@example.com' } });

    expect(result.user).toEqual({ id: 'device-abc' });
  });

  it('scrubs exception values and stack frames', () => {
    const result = scrub({
      exception: {
        values: [
          {
            value: 'ENOENT /Users/liam/notes token=SUPERSECRET',
            stacktrace: { frames: [{ filename: '/Users/liam/app.js', abs_path: '/Users/liam/app.js', vars: { token: 'bare' } }] },
          },
        ],
      },
    });

    expect(result.exception.values[0].value).not.toContain('/Users/liam');
    expect(result.exception.values[0].value).not.toContain('SUPERSECRET');
    expect(result.exception.values[0].stacktrace.frames[0].filename).toBe('~/app.js');
    expect(result.exception.values[0].stacktrace.frames[0].vars.token).toBe('[Filtered]');
  });
});

describe('scrubBreadcrumb', () => {
  it('walks data as a whole object so a bare credential under a sensitive key is caught', () => {
    const result = scrubBreadcrumb({
      message: 'fetch /Users/liam/x',
      data: { token: 'bare-secret-value' },
    } as Breadcrumb) as unknown as Record<string, any>;

    expect(result.data.token).toBe('[Filtered]');
    expect(result.message).not.toContain('/Users/liam');
  });

  it('strips query strings from fetch/xhr and navigation crumbs', () => {
    const result = scrubBreadcrumb({
      data: { url: 'https://hub.local/api/apps?q=private', from: '/a?x=1', to: '/b#f' },
    } as Breadcrumb) as unknown as Record<string, any>;

    expect(result.data.url).toBe('https://hub.local/api/apps');
    expect(result.data.from).toBe('/a');
    expect(result.data.to).toBe('/b');
  });

  it('filters http.query and http.fragment by name', () => {
    const result = scrubBreadcrumb({
      data: { 'http.query': '?token=SUPERSECRET', 'http.fragment': '#private', 'http.method': 'GET' },
    } as Breadcrumb) as unknown as Record<string, any>;

    expect(result.data['http.query']).toBe('[Filtered]');
    expect(result.data['http.fragment']).toBe('[Filtered]');
    expect(result.data['http.method']).toBe('GET');
  });

  it('scrubs raw console arguments', () => {
    const result = scrubBreadcrumb({
      message: 'console error',
      data: { arguments: ['failed for /Users/liam', 'api_key=SUPERSECRET'] },
    } as Breadcrumb) as unknown as Record<string, any>;

    expect(result.data.arguments[0]).toBe('failed for ~');
    expect(result.data.arguments[1]).not.toContain('SUPERSECRET');
  });
});
