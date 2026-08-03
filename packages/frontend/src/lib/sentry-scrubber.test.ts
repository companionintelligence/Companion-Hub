import type { Breadcrumb, ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubBrowserEvent, scrubString, scrubUrl } from './sentry-scrubber';

const scrub = (event: unknown) => scrubBrowserEvent(event as ErrorEvent) as unknown as Record<string, any>;

const crumb = (breadcrumb: unknown) => scrubBreadcrumb(breadcrumb as Breadcrumb) as unknown as Record<string, any>;

function firstFrame(event: unknown) {
  const [frame] = scrubBrowserEvent(event as ErrorEvent).exception?.values?.[0]?.stacktrace?.frames ?? [];
  return frame;
}

describe('scrubString', () => {
  it('collapses home paths on every platform', () => {
    expect(scrubString('/Users/liam/notes')).toBe('~/notes');
    expect(scrubString('/home/ci/state')).toBe('~/state');
    // Windows must win over the macOS pattern, or a stranded `C:~/…` is left.
    expect(scrubString('C:\\Users\\liam\\AppData')).toBe('~\\AppData');
    expect(scrubString('C:/Users/liam/AppData')).toBe('~/AppData');
  });

  it('collapses home directories, which leak account names', () => {
    expect(scrubString('/Users/bennett/devel/x.ts')).toBe('~/devel/x.ts');
    expect(scrubString('/home/ci/data/hub.db')).toBe('~/data/hub.db');
    expect(scrubString('C:\\Users\\bennett\\app.log')).toBe('~\\app.log');
    // Regression: the macOS rule used to match inside this and leave `C:~/…`.
    expect(scrubString('C:/Users/bennett/AppData/ci')).toBe('~/AppData/ci');
  });

  it('collapses the macOS Application Support path', () => {
    // Desktop builds run this bundle inside Tauri, where the Hub data directory
    // shows up verbatim in error text.
    expect(scrubString('ENOENT at /Users/liam/Library/Application Support/companion-hub/state.json')).not.toContain('companion-hub/state.json');
  });

  it('redacts credentials, including hyphenated api-key forms', () => {
    expect(scrubString('Authorization: Bearer abc123DEF')).not.toContain('abc123DEF');
    expect(scrubString('x-api-key: KEYVALUE123')).not.toContain('KEYVALUE123');
    expect(scrubString('tskey-auth-abc123')).not.toContain('abc123');
    expect(scrubString('postgres://ci:hunter2@db:5432/hub')).not.toContain('hunter2');
  });

  it('redacts bearer tokens, labelled secrets and tailscale keys', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubString('api_key=sk-live-1234567890')).not.toContain('sk-live-1234567890');
    expect(scrubString('api-key: ci_live_0987654321')).not.toContain('ci_live_0987654321');
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts credentials embedded in connection URLs', () => {
    expect(scrubString('postgres://ci:pgadmin_s3cure@ci-hub-db:5432/hub')).not.toContain('pgadmin_s3cure');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed).toHaveLength(8000 + '… [truncated]'.length);
    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
    expect(scrubbed.length).toBeLessThan(9000);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubString('Cannot read properties of undefined (reading "id")')).toBe('Cannot read properties of undefined (reading "id")');
  });
});

describe('scrubUrl', () => {
  it('strips query and fragment without touching the path', () => {
    expect(scrubUrl('https://hub.local/apps?q=private#frag')).toBe('https://hub.local/apps');
    expect(scrubUrl('/apps')).toBe('/apps');
  });

  it('drops the query and hash', () => {
    expect(scrubUrl('https://hub.ci.localhost/store?search=therapy#top')).toBe('https://hub.ci.localhost/store');
  });

  it('returns path-only URLs unchanged', () => {
    expect(scrubUrl('/api/apps')).toBe('/api/apps');
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
    expect(result.request.query_string).toBe('[Filtered]');
  });

  it('strips the query string from request.url', () => {
    // httpContextIntegration sets request.url from location.href, so an error
    // thrown on the reset-password page ships the live token.
    const event = { request: { url: 'https://hub.ci.localhost/auth/reset-password?token=one-time-secret' } };

    expect(scrub(event).request.url).toBe('https://hub.ci.localhost/auth/reset-password');
  });

  it('drops cookies, body and query string', () => {
    const result = scrub({
      request: {
        cookies: { 'ci-hub-session': 'eyJhbGciOiJIUzI1NiJ9.session.value' },
        data: { email: 'liam@example.com', password: 'hunter2' },
        query_string: 'token=one-time-secret',
        headers: { cookie: 'ci-hub-session=abc', 'User-Agent': 'Mozilla/5.0' },
      },
    });

    expect(result.request.cookies).toBeUndefined();
    expect(result.request.data).toBeUndefined();
    expect(result.request.query_string).toBe('[Filtered]');
    expect(result.request.headers.cookie).toBe('[Filtered]');
    expect(result.request.headers['User-Agent']).toBe('Mozilla/5.0');
  });

  it('strips the query string from the referer header', () => {
    const event = { request: { headers: { Referer: 'https://hub.ci.localhost/store?search=private' } } };

    expect(scrub(event).request.headers.Referer).toBe('https://hub.ci.localhost/store');
  });

  it.each(['x-ci-hub-user', 'username', 'email'])('filters the identity-bearing key %s', (key) => {
    const event = { request: { headers: { [key]: 'bennett' } } };

    expect(scrub(event).request.headers[key]).toBe('[Filtered]');
  });

  it.each(['user-agent', 'user_id', 'owner_id'])('keeps %s as diagnostic signal', (key) => {
    const event = { request: { headers: { [key]: 'Mozilla/5.0' } } };

    expect(scrub(event).request.headers[key]).toBe('Mozilla/5.0');
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

  it('filters sensitive keys in extra, at any depth', () => {
    const result = scrub({
      extra: { outer: { password: 'hunter2', note: '/home/ci/x' }, response_body: 'token=leaked-value' },
    });

    expect(result.extra.outer.password).toBe('[Filtered]');
    expect(result.extra.outer.note).toBe('~/x');
    expect(result.extra.response_body).not.toContain('leaked-value');
  });

  it('keeps user.id but drops other user identifiers', () => {
    const result = scrub({ user: { id: 'device-abc', ip_address: '203.0.113.42', email: 'liam@example.com' } });

    expect(result.user).toEqual({ id: 'device-abc' });
  });

  it('scrubs the message and exception values', () => {
    const result = scrub({
      message: 'failed for /Users/bennett/notes',
      exception: { values: [{ value: 'Bearer secrettokenvalue rejected' }] },
    });

    expect(result.message).toBe('failed for ~/notes');
    expect(result.exception.values[0].value).not.toContain('secrettokenvalue');
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

  it('scrubs stack frame paths and captured locals', () => {
    const frame = firstFrame({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [{ filename: '/Users/bennett/devel/x.tsx', abs_path: '/Users/bennett/devel/x.tsx', vars: { password: 'hunter2' } }],
            },
          },
        ],
      },
    });

    expect(frame?.filename).toBe('~/devel/x.tsx');
    expect(frame?.abs_path).toBe('~/devel/x.tsx');
    expect(frame?.vars?.password).toBe('[Filtered]');
  });

  it('scrubs source context if anything attaches it', () => {
    // Kept in parity with the backend twin: the browser SDK does not attach
    // source context by default, but nothing stops a producer from doing so.
    const frame = firstFrame({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  pre_context: ['const dir = "/Users/bennett/notes";'],
                  context_line: 'const client = new Client({ api_key: "sk-live-9988776655" });',
                  post_context: ['await fetch(url, { headers: { authorization: "Bearer abcdefghij" } });'],
                },
              ],
            },
          },
        ],
      },
    });

    expect(frame?.context_line).not.toContain('sk-live-9988776655');
    expect(frame?.pre_context?.[0]).toBe('const dir = "~/notes";');
    expect(frame?.post_context?.[0]).not.toContain('abcdefghij');
  });

  it('removes the machine hostname', () => {
    expect(scrub({ server_name: 'Bennetts-MacBook-Pro.local' }).server_name).toBeUndefined();
  });

  it('strips query strings from URL-valued breadcrumb data', () => {
    const result = scrub({
      breadcrumbs: [
        { category: 'navigation', data: { from: '/login', to: '/auth/reset-password?token=one-time-secret' } },
        { category: 'fetch', data: { url: '/api/store/search?q=private+app', status_code: 500 } },
      ],
    });

    const [navigation, fetchCrumb] = result.breadcrumbs;
    expect(navigation.data.to).toBe('/auth/reset-password');
    expect(navigation.data.from).toBe('/login');
    expect(fetchCrumb.data.url).toBe('/api/store/search');
    expect(fetchCrumb.data.status_code).toBe(500);
  });

  it('survives a cyclic extra payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrub({ extra: cyclic })).not.toThrow();
  });

  it('passes through an event with nothing to scrub', () => {
    expect(scrub({ message: 'plain failure' })).toEqual({ message: 'plain failure' });
  });
});

describe('scrubBreadcrumb', () => {
  it('walks data as a whole object so a bare credential under a sensitive key is caught', () => {
    const result = crumb({
      message: 'fetch /Users/liam/x',
      data: { token: 'bare-secret-value' },
    });

    expect(result.data.token).toBe('[Filtered]');
    expect(result.message).not.toContain('/Users/liam');
  });

  it('strips query strings from fetch/xhr and navigation crumbs', () => {
    const result = crumb({
      data: { url: 'https://hub.local/api/apps?q=private', from: '/a?x=1', to: '/b#f' },
    });

    expect(result.data.url).toBe('https://hub.local/api/apps');
    expect(result.data.from).toBe('/a');
    expect(result.data.to).toBe('/b');
  });

  it('filters http.query and http.fragment by name', () => {
    const result = crumb({
      data: { 'http.query': '?token=SUPERSECRET', 'http.fragment': '#private', 'http.method': 'GET' },
    });

    expect(result.data['http.query']).toBe('[Filtered]');
    expect(result.data['http.fragment']).toBe('[Filtered]');
    expect(result.data['http.method']).toBe('GET');
  });

  it('scrubs raw console arguments', () => {
    const result = crumb({
      message: 'console error',
      data: { arguments: ['failed for /Users/liam', 'api_key=SUPERSECRET'] },
    });

    expect(result.data.arguments[0]).toBe('failed for ~');
    expect(result.data.arguments[1]).not.toContain('SUPERSECRET');
  });
});
