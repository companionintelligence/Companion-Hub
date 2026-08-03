import type { ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';
import { scrubEvent, scrubString, scrubUrl } from './sentry-scrubber';

function firstFrame(event: ErrorEvent) {
  const [frame] = scrubEvent(event).exception?.values?.[0]?.stacktrace?.frames ?? [];
  return frame;
}

describe('scrubString', () => {
  it('redacts bearer tokens, labelled secrets and tailscale keys', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubString('api_key=sk-live-1234567890')).not.toContain('sk-live-1234567890');
    expect(scrubString('api-key: ci_live_0987654321')).not.toContain('ci_live_0987654321');
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts credentials embedded in connection URLs', () => {
    expect(scrubString('postgres://ci:pgadmin_s3cure@ci-hub-db:5432/hub')).not.toContain('pgadmin_s3cure');
  });

  it('collapses home directories, which leak account names', () => {
    expect(scrubString('/Users/bennett/devel/x.ts')).toBe('~/devel/x.ts');
    expect(scrubString('/home/ci/data/hub.db')).toBe('~/data/hub.db');
    expect(scrubString('C:\\Users\\bennett\\app.log')).toBe('~\\app.log');
    // Regression: the macOS rule used to match inside this and leave `C:~/…`.
    expect(scrubString('C:/Users/bennett/AppData/ci')).toBe('~/AppData/ci');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed).toHaveLength(8000 + '… [truncated]'.length);
    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubString('Cannot read properties of undefined (reading "id")')).toBe('Cannot read properties of undefined (reading "id")');
  });
});

describe('scrubUrl', () => {
  it('drops the query and hash', () => {
    expect(scrubUrl('https://hub.ci.localhost/store?search=therapy#top')).toBe('https://hub.ci.localhost/store');
  });

  it('returns path-only URLs unchanged', () => {
    expect(scrubUrl('/api/apps')).toBe('/api/apps');
  });
});

describe('scrubEvent', () => {
  it('strips the query string from request.url', () => {
    // httpContextIntegration sets request.url from location.href, so an error
    // thrown on the reset-password page ships the live token.
    const event = {
      request: { url: 'https://hub.ci.localhost/auth/reset-password?token=one-time-secret' },
    } as unknown as ErrorEvent;

    expect(scrubEvent(event).request?.url).toBe('https://hub.ci.localhost/auth/reset-password');
  });

  it('drops cookies, body and query string', () => {
    const event = {
      request: {
        cookies: { 'ci-hub-session': 'eyJhbGciOiJIUzI1NiJ9.session.value' },
        data: { email: 'liam@example.com', password: 'hunter2' },
        query_string: 'token=one-time-secret',
        headers: { cookie: 'ci-hub-session=abc', 'User-Agent': 'Mozilla/5.0' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBe('[Filtered]');
    expect(scrubbed.request?.headers?.cookie).toBe('[Filtered]');
    expect(scrubbed.request?.headers?.['User-Agent']).toBe('Mozilla/5.0');
  });

  it('strips the query string from the referer header', () => {
    const event = { request: { headers: { Referer: 'https://hub.ci.localhost/store?search=private' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event).request?.headers?.Referer).toBe('https://hub.ci.localhost/store');
  });

  it.each(['x-ci-hub-user', 'username', 'email'])('filters the identity-bearing key %s', (key) => {
    const event = { request: { headers: { [key]: 'bennett' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event).request?.headers?.[key]).toBe('[Filtered]');
  });

  it.each(['user-agent', 'user_id', 'owner_id'])('keeps %s as diagnostic signal', (key) => {
    const event = { request: { headers: { [key]: 'Mozilla/5.0' } } } as unknown as ErrorEvent;

    expect(scrubEvent(event).request?.headers?.[key]).toBe('Mozilla/5.0');
  });

  it('scrubs the message and exception values', () => {
    const event = {
      message: 'failed for /Users/bennett/notes',
      exception: { values: [{ value: 'Bearer secrettokenvalue rejected' }] },
    } as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.message).toBe('failed for ~/notes');
    expect(scrubbed.exception?.values?.[0]?.value).not.toContain('secrettokenvalue');
  });

  it('filters sensitive keys in extra, at any depth', () => {
    const event = {
      extra: { outer: { password: 'hunter2', note: '/home/ci/x' }, response_body: 'token=leaked-value' },
    } as unknown as ErrorEvent;

    const extra = scrubEvent(event).extra as { outer: { password: string; note: string }; response_body: string };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.outer.note).toBe('~/x');
    expect(extra.response_body).not.toContain('leaked-value');
  });

  it('strips query strings from URL-valued breadcrumb data', () => {
    const event = {
      breadcrumbs: [
        { category: 'navigation', data: { from: '/login', to: '/auth/reset-password?token=one-time-secret' } },
        { category: 'fetch', data: { url: '/api/store/search?q=private+app', status_code: 500 } },
      ],
    } as unknown as ErrorEvent;

    const [navigation, fetchCrumb] = scrubEvent(event).breadcrumbs ?? [];

    expect(navigation?.data?.to).toBe('/auth/reset-password');
    expect(navigation?.data?.from).toBe('/login');
    expect(fetchCrumb?.data?.url).toBe('/api/store/search');
    expect(fetchCrumb?.data?.status_code).toBe(500);
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
    } as unknown as ErrorEvent);

    expect(frame?.filename).toBe('~/devel/x.tsx');
    expect(frame?.abs_path).toBe('~/devel/x.tsx');
    expect(frame?.vars?.password).toBe('[Filtered]');
  });

  it('removes the machine hostname', () => {
    const event = { server_name: 'Bennetts-MacBook-Pro.local' } as ErrorEvent;

    expect(scrubEvent(event).server_name).toBeUndefined();
  });

  it('survives a cyclic extra payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrubEvent({ extra: cyclic } as unknown as ErrorEvent)).not.toThrow();
  });

  it('passes through an event with nothing to scrub', () => {
    expect(scrubEvent({ message: 'plain failure' } as ErrorEvent)).toEqual({ message: 'plain failure' });
  });
});
