import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { scrubEvent, scrubString, scrubUrl } from './sentry-scrubber';

/** `scrubEvent`'s hint is only read for the transient-DB regroup. */
const noHint = {} as never;

/** Scrub an event that is expected to survive, so assertions stay unguarded. */
function scrub(event: ErrorEvent): ErrorEvent {
  const scrubbed = scrubEvent(event, noHint);
  if (!scrubbed) {
    throw new Error('scrubEvent unexpectedly dropped the event');
  }
  return scrubbed;
}

function firstFrame(event: ErrorEvent) {
  const [frame] = scrub(event).exception?.values?.[0]?.stacktrace?.frames ?? [];
  return frame;
}

describe('scrubString', () => {
  it('redacts home paths and secrets', () => {
    const input = 'Failed at /Users/alice/Library/Application Support/companion-hub token=super-secret JWT_SECRET=abc123';
    const scrubbed = scrubString(input);

    expect(scrubbed).not.toContain('/Users/alice');
    expect(scrubbed).toContain('[Filtered]');
  });

  it('redacts Linux home paths', () => {
    const scrubbed = scrubString('EACCES at /home/bennett/.internal/state/settings.json');

    expect(scrubbed).not.toContain('/home/bennett');
    expect(scrubbed).toContain('~');
  });

  it('redacts Windows user paths', () => {
    const scrubbed = scrubString('Failed at C:\\Users\\Bennett\\AppData\\Roaming\\companion-hub');

    expect(scrubbed).not.toContain('C:\\Users\\Bennett');
    expect(scrubbed).toContain('~');
  });

  it('collapses Windows home paths in both slash styles', () => {
    // Regression: the macOS pattern used to match inside `C:/Users/…` first,
    // leaving a stranded `C:~/…` with the drive letter still attached.
    expect(scrubString('C:\\Users\\bennett\\app.log')).toBe('~\\app.log');
    expect(scrubString('C:/Users/bennett/AppData/ci')).toBe('~/AppData/ci');
  });

  it('redacts bearer tokens and tailscale auth keys', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts the hyphenated api-key form', () => {
    // `x-api-key` reaches us as a header key AND inside logged header dumps.
    expect(scrubString('api-key: ci_live_0987654321')).not.toContain('ci_live_0987654321');
  });

  it('redacts credentials embedded in connection URLs', () => {
    const scrubbed = scrubString('postgres://ci:pgadmin_s3cure@ci-hub-db:5432/hub');

    expect(scrubbed).not.toContain('pgadmin_s3cure');
    expect(scrubbed).toContain('[Filtered]');
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

describe('scrubEvent transient DB handling', () => {
  it('downgrades and fingerprints EAI_AGAIN query failures', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    const event = {
      level: 'error',
      exception: { values: [{ type: 'Error', value: 'Failed query: select id from user' }] },
      tags: {},
    };

    const result = scrubEvent(event as never, { originalException: cause });

    expect(result?.level).toBe('warning');
    expect(result?.fingerprint).toEqual(['transient-db-unreachable']);
    expect(result?.tags?.error_class).toBe('transient-db-unreachable');
  });

  it('downgrades ApiKeyStoreUnavailableError the same way', () => {
    const event = {
      level: 'error',
      exception: { values: [{ type: 'ApiKeyStoreUnavailableError', value: 'API key store unavailable: database unreachable' }] },
      tags: {},
    };

    const result = scrubEvent(event as never, {
      originalException: new ApiKeyStoreUnavailableError(new Error('getaddrinfo EAI_AGAIN ci-hub-db')),
    });

    expect(result?.level).toBe('warning');
    expect(result?.fingerprint).toEqual(['transient-db-unreachable']);
  });
});

describe('scrubEvent request payload', () => {
  // `include.cookies` defaults to on and is NOT gated behind `sendDefaultPii`,
  // so these arrive whatever that flag is set to.
  it('drops cookies, body and query string', () => {
    const event = {
      request: {
        cookies: { 'ci-hub-session': 'eyJhbGciOiJIUzI1NiJ9.session.value' },
        data: { email: 'liam@example.com', password: 'hunter2' },
        query_string: 'search=private+app',
        headers: { authorization: 'Bearer abc', 'user-agent': 'curl/8' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrub(event);

    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBe('[Filtered]');
    expect(scrubbed.request?.headers?.authorization).toBe('[Filtered]');
    expect(scrubbed.request?.headers?.['user-agent']).toBe('curl/8');
  });

  it('strips the query string from request.url, not just query_string', () => {
    // The SDK builds request.url from req.url, which on a Node server is
    // path+query — so filtering query_string alone redacted nothing.
    const event = {
      request: {
        url: 'https://hub.ci.localhost/auth/reset-password?token=one-time-secret',
        query_string: 'token=one-time-secret',
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrub(event);

    expect(scrubbed.request?.url).toBe('https://hub.ci.localhost/auth/reset-password');
    expect(scrubbed.request?.query_string).toBe('[Filtered]');
  });

  it('filters the cookie header, not only the parsed cookies map', () => {
    const event = { request: { headers: { cookie: 'ci-hub-session=eyJhbGciOiJIUzI1NiJ9' } } } as unknown as ErrorEvent;

    expect(scrub(event).request?.headers?.cookie).toBe('[Filtered]');
  });

  it('filters the hyphenated x-api-key header', () => {
    const event = { request: { headers: { 'x-api-key': 'ci_live_abcdef123456' } } } as unknown as ErrorEvent;

    expect(scrub(event).request?.headers?.['x-api-key']).toBe('[Filtered]');
  });

  it('strips the query string from URL-valued headers', () => {
    const event = {
      request: { headers: { Referer: 'https://hub.ci.localhost/store?search=private', location: '/settings?tab=account' } },
    } as unknown as ErrorEvent;

    const headers = scrub(event).request?.headers;

    expect(headers?.Referer).toBe('https://hub.ci.localhost/store');
    expect(headers?.location).toBe('/settings');
  });

  it('tolerates an event with no request section', () => {
    const event = { message: 'plain failure' } as ErrorEvent;

    expect(scrub(event).message).toBe('plain failure');
  });
});

describe('scrubEvent identity-bearing keys', () => {
  // These name a PERSON; no value pattern can match a username. The hub sits
  // behind its own Traefik forward-auth, which injects headers our code never
  // references.
  it.each(['x-ci-hub-user', 'x-forwarded-user', 'x-ci-owner', 'username', 'email'])('filters %s', (key) => {
    const event = { request: { headers: { [key]: 'bennett' } } } as unknown as ErrorEvent;

    expect(scrub(event).request?.headers?.[key]).toBe('[Filtered]');
  });

  it.each(['user-agent', 'user_id', 'owner_id'])('keeps %s as diagnostic signal', (key) => {
    const event = { request: { headers: { [key]: 'curl/8' } } } as unknown as ErrorEvent;

    expect(scrub(event).request?.headers?.[key]).toBe('curl/8');
  });
});

describe('scrubEvent hostname and stack frames', () => {
  it('removes the machine hostname', () => {
    const event = { server_name: 'Bennetts-MacBook-Pro.local' } as ErrorEvent;

    expect(scrub(event).server_name).toBeUndefined();
  });

  it('scrubs stack frame paths and captured locals', () => {
    const frame = firstFrame({
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/bennett/devel/ci/CI-Hub/x.ts',
                  abs_path: '/Users/bennett/devel/ci/CI-Hub/x.ts',
                  vars: { composePath: '/home/ci/apps/immich', password: 'hunter2' },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent);

    expect(frame?.filename).toBe('~/devel/ci/CI-Hub/x.ts');
    expect(frame?.abs_path).toBe('~/devel/ci/CI-Hub/x.ts');
    expect(frame?.vars?.composePath).toBe('~/apps/immich');
    expect(frame?.vars?.password).toBe('[Filtered]');
  });

  it('scrubs context_line, pre_context and post_context', () => {
    // The ContextLines integration attaches the source around the throw site —
    // hardcoded keys and connection strings live there.
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
    } as unknown as ErrorEvent);

    expect(frame?.context_line).not.toContain('sk-live-9988776655');
    expect(frame?.pre_context?.[0]).toBe('const dir = "~/notes";');
    expect(frame?.post_context?.[0]).not.toContain('abcdefghij');
  });
});

describe('scrubEvent extra and breadcrumbs', () => {
  it('filters sensitive keys in extra, at any depth', () => {
    const event = {
      extra: {
        outer: { password: 'hunter2', note: '/home/ci/x' },
        dsn: 'https://key@o1.ingest.sentry.io/2',
      },
    } as unknown as ErrorEvent;

    const extra = scrub(event).extra as { outer: { password: string; note: string }; dsn: string };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.outer.note).toBe('~/x');
    expect(extra.dsn).toBe('[Filtered]');
  });

  it('scrubs breadcrumb data, not only the message', () => {
    const event = {
      breadcrumbs: [{ message: 'GET /Users/bennett', data: { token: 'abc123', url: '/api/apps' } }],
    } as unknown as ErrorEvent;

    const [breadcrumb] = scrub(event).breadcrumbs ?? [];

    expect(breadcrumb?.message).toBe('GET ~');
    expect(breadcrumb?.data?.token).toBe('[Filtered]');
    expect(breadcrumb?.data?.url).toBe('/api/apps');
  });

  it('strips query strings from URL-valued breadcrumb data', () => {
    const event = {
      breadcrumbs: [{ category: 'http', data: { url: '/api/store/search?q=private+app', status_code: 500 } }],
    } as unknown as ErrorEvent;

    const [breadcrumb] = scrub(event).breadcrumbs ?? [];

    expect(breadcrumb?.data?.url).toBe('/api/store/search');
    expect(breadcrumb?.data?.status_code).toBe(500);
  });

  it('survives a cyclic extra payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrub({ extra: cyclic } as unknown as ErrorEvent)).not.toThrow();
  });
});
