import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { scrubEvent, scrubString, scrubUrl } from './sentry-scrubber';

/** `scrubEvent`'s hint is only read for the transient-DB regroup. */
const noHint = {} as never;

/** Scrub an event that is expected to survive, so assertions stay unguarded. */
function scrub(event: unknown): ErrorEvent {
  const scrubbed = scrubEvent(event as ErrorEvent, noHint);
  if (!scrubbed) {
    throw new Error('scrubEvent unexpectedly dropped the event');
  }
  return scrubbed;
}

function firstFrame(event: unknown) {
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

  it('collapses macOS and Linux home directories exactly', () => {
    expect(scrubString('/Users/bennett/devel/x.ts')).toBe('~/devel/x.ts');
    expect(scrubString('/home/ci/data/hub.db')).toBe('~/data/hub.db');
  });

  it('redacts bearer tokens and tailscale auth keys', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts the hyphenated api-key form', () => {
    // `x-api-key` reaches us as a header key AND inside logged header dumps.
    expect(scrubString('api-key: ci_live_0987654321')).not.toContain('ci_live_0987654321');
    expect(scrubString('api_key=sk-live-1234567890')).not.toContain('sk-live-1234567890');
  });

  it('redacts credentials embedded in connection URLs', () => {
    const scrubbed = scrubString('postgres://ci:pgadmin_s3cure@ci-hub-db:5432/hub');

    expect(scrubbed).not.toContain('pgadmin_s3cure');
    expect(scrubbed).toContain('[Filtered]');
    expect(scrubString('postgres://ci:hunter2@ci-hub-db:5432/hub')).not.toContain('hunter2');
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
  it('drops the query and hash', () => {
    expect(scrubUrl('https://hub.ci.localhost/store?search=therapy#top')).toBe('https://hub.ci.localhost/store');
    expect(scrubUrl('https://hub.local/api/apps?q=x#f')).toBe('https://hub.local/api/apps');
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

describe('key denylist', () => {
  it('filters hyphenated api-key headers, signatures and identity keys', () => {
    // A bare credential value matches no SECRET_PATTERN, so the KEY is the only
    // signal. `x-api-key` used to fall through: it contains neither `apikey`
    // nor `api_key`.
    const result = scrub({
      extra: {
        'x-api-key': 'ci_hub_9f3a7c21be40',
        'X-API-Key': 'ci_hub_9f3a7c21be40',
        signature: 'deadbeef',
        email: 'liam@example.com',
        username: 'liam',
        user: 'liam',
        owner: 'liam',
        'x-forwarded-for': '203.0.113.42',
        forwarded: 'for=203.0.113.42',
        'remote-addr': '203.0.113.42',
        'x-ci-hub-user': 'liam',
      },
    });

    for (const [key, value] of Object.entries(result.extra ?? {})) {
      expect(value, `${key} was not filtered`).toBe('[Filtered]');
    }
  });

  it('keeps diagnostic keys that merely look identity-ish', () => {
    const result = scrub({
      extra: { 'user-agent': 'curl/8.0', user_id: 'abc', owner_id: 'def', http_status: 500 },
    });

    expect(result.extra).toEqual({ 'user-agent': 'curl/8.0', user_id: 'abc', owner_id: 'def', http_status: 500 });
  });
});

describe('request data the SDK attaches behind our backs', () => {
  it('strips url query, query_string, cookies, body and sensitive headers', () => {
    const result = scrub({
      request: {
        url: 'http://hub.local/api/apps/install?token=SUPERSECRET&app=private-notes',
        query_string: 'token=SUPERSECRET&app=private-notes',
        cookies: { 'ci-hub-session': 'abc123' },
        data: { password: 'hunter2' },
        headers: {
          cookie: 'ci-hub-session=abc123',
          authorization: 'Bearer abc123DEF',
          'x-api-key': 'ci_hub_9f3a',
          'x-ci-hub-user': 'liam',
          referer: 'http://hub.local/apps?q=private-notes',
          'user-agent': 'curl/8.0',
        },
      },
    });

    const request = result.request as Record<string, unknown>;
    expect(request.url).toBe('http://hub.local/api/apps/install');
    expect(request.query_string).toBe('[Filtered]');
    expect(request.cookies).toBeUndefined();
    expect(request.data).toBeUndefined();

    const headers = request.headers as Record<string, string>;
    expect(headers.cookie).toBe('[Filtered]');
    expect(headers.authorization).toBe('[Filtered]');
    expect(headers['x-api-key']).toBe('[Filtered]');
    expect(headers['x-ci-hub-user']).toBe('[Filtered]');
    // Referrer keeps its path but loses the query — that is where search terms live.
    expect(headers.referer).toBe('http://hub.local/apps');
    expect(headers['user-agent']).toBe('curl/8.0');
  });

  it('drops cookies, body and query string', () => {
    // `include.cookies` defaults to on and is NOT gated behind `sendDefaultPii`,
    // so these arrive whatever that flag is set to.
    const event = {
      request: {
        cookies: { 'ci-hub-session': 'eyJhbGciOiJIUzI1NiJ9.session.value' },
        data: { email: 'liam@example.com', password: 'hunter2' },
        query_string: 'search=private+app',
        headers: { authorization: 'Bearer abc', 'user-agent': 'curl/8' },
      },
    };

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
    };

    const scrubbed = scrub(event);

    expect(scrubbed.request?.url).toBe('https://hub.ci.localhost/auth/reset-password');
    expect(scrubbed.request?.query_string).toBe('[Filtered]');
  });

  it('filters the cookie header, not only the parsed cookies map', () => {
    const event = { request: { headers: { cookie: 'ci-hub-session=eyJhbGciOiJIUzI1NiJ9' } } };

    expect(scrub(event).request?.headers?.cookie).toBe('[Filtered]');
  });

  it('filters the hyphenated x-api-key header', () => {
    const event = { request: { headers: { 'x-api-key': 'ci_live_abcdef123456' } } };

    expect(scrub(event).request?.headers?.['x-api-key']).toBe('[Filtered]');
  });

  it('strips the query string from URL-valued headers', () => {
    const event = {
      request: { headers: { Referer: 'https://hub.ci.localhost/store?search=private', location: '/settings?tab=account' } },
    };

    const headers = scrub(event).request?.headers;

    expect(headers?.Referer).toBe('https://hub.ci.localhost/store');
    expect(headers?.location).toBe('/settings');
  });

  it('tolerates an event with no request section', () => {
    const event = { message: 'plain failure' };

    expect(scrub(event).message).toBe('plain failure');
  });

  it('drops the machine hostname', () => {
    expect(scrub({ server_name: 'MacBook-Pro-2.local' }).server_name).toBeUndefined();
    expect(scrub({ server_name: 'Bennetts-MacBook-Pro.local' }).server_name).toBeUndefined();
  });

  it('keeps user.id but drops every other user identifier', () => {
    const result = scrub({
      user: { id: 'device-abc', ip_address: '203.0.113.42', email: 'liam@example.com', username: 'liam' },
    });

    expect(result.user).toEqual({ id: 'device-abc' });
  });
});

describe('scrubEvent identity-bearing keys', () => {
  // These name a PERSON; no value pattern can match a username. The hub sits
  // behind its own Traefik forward-auth, which injects headers our code never
  // references.
  it.each(['x-ci-hub-user', 'x-forwarded-user', 'x-ci-owner', 'username', 'email'])('filters %s', (key) => {
    const event = { request: { headers: { [key]: 'bennett' } } };

    expect(scrub(event).request?.headers?.[key]).toBe('[Filtered]');
  });

  it.each(['user-agent', 'user_id', 'owner_id'])('keeps %s as diagnostic signal', (key) => {
    const event = { request: { headers: { [key]: 'curl/8' } } };

    expect(scrub(event).request?.headers?.[key]).toBe('curl/8');
  });
});

describe('stack frames', () => {
  it('scrubs filename, abs_path, context lines and captured vars', () => {
    const result = scrub({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/liam/devel/ci/CI-Hub/packages/backend/src/app.ts',
                  abs_path: '/Users/liam/devel/ci/CI-Hub/packages/backend/src/app.ts',
                  context_line: "const key = 'api_key=ci_hub_9f3a7c21be40';",
                  pre_context: ['// /Users/liam/notes'],
                  post_context: ['await fetch(`https://x/?token=SUPERSECRET`);'],
                  vars: { token: 'bare-secret', path: '/Users/liam/notes' },
                },
              ],
            },
          },
        ],
      },
    });

    const frame = (result.exception?.values?.[0]?.stacktrace?.frames ?? [])[0] as Record<string, unknown>;
    expect(frame.filename).not.toContain('/Users/liam');
    expect(frame.abs_path).not.toContain('/Users/liam');
    expect(frame.context_line).not.toContain('ci_hub_9f3a7c21be40');
    expect((frame.pre_context as string[])[0]).not.toContain('/Users/liam');
    expect((frame.post_context as string[])[0]).not.toContain('SUPERSECRET');
    // A bare value under a sensitive key is caught by the key check.
    expect((frame.vars as Record<string, unknown>).token).toBe('[Filtered]');
    expect((frame.vars as Record<string, unknown>).path).not.toContain('/Users/liam');
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
    });

    expect(frame?.filename).toBe('~/devel/ci/CI-Hub/x.ts');
    expect(frame?.abs_path).toBe('~/devel/ci/CI-Hub/x.ts');
    expect(frame?.vars?.composePath).toBe('~/apps/immich');
    expect(frame?.vars?.password).toBe('[Filtered]');
  });

  it('scrubs context_line, pre_context and post_context', () => {
    // ContextLines is disabled in instrument.ts (MANUALLY_HANDLED_INTEGRATIONS)
    // because seven lines of arbitrary source per frame is an unbounded channel
    // a denylist cannot close. This stays as the belt-and-braces half: anything
    // else that attaches source context still gets scrubbed.
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
});

describe('extra', () => {
  it('filters sensitive keys in extra, at any depth', () => {
    const event = {
      extra: {
        outer: { password: 'hunter2', note: '/home/ci/x' },
        dsn: 'https://key@o1.ingest.sentry.io/2',
      },
    };

    const extra = scrub(event).extra as { outer: { password: string; note: string }; dsn: string };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.outer.note).toBe('~/x');
    expect(extra.dsn).toBe('[Filtered]');
  });

  it('survives a cyclic extra payload', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrub({ extra: cyclic })).not.toThrow();
  });
});

describe('breadcrumbs', () => {
  it('walks data as a whole object so bare credentials under sensitive keys are caught', () => {
    // Scrubbing each value individually would miss this: `bare-secret-value`
    // matches no secret pattern, and only the KEY identifies it.
    const result = scrub({
      breadcrumbs: [{ message: 'fetch /Users/liam/x', data: { token: 'bare-secret-value' } }],
    });

    const crumb = (result.breadcrumbs ?? [])[0] as Record<string, unknown>;
    expect((crumb.data as Record<string, unknown>).token).toBe('[Filtered]');
    expect(crumb.message).not.toContain('/Users/liam');
  });

  it('scrubs breadcrumb data, not only the message', () => {
    const event = {
      breadcrumbs: [{ message: 'GET /Users/bennett', data: { token: 'abc123', url: '/api/apps' } }],
    };

    const [breadcrumb] = scrub(event).breadcrumbs ?? [];

    expect(breadcrumb?.message).toBe('GET ~');
    expect(breadcrumb?.data?.token).toBe('[Filtered]');
    expect(breadcrumb?.data?.url).toBe('/api/apps');
  });

  it('filters http.query and http.fragment by name', () => {
    // nativeNodeFetchIntegration sanitises `data.url` but re-attaches the parts
    // it removed as `http.query` / `http.fragment`. They match no pattern and no
    // sensitive key, so the name is the only handle. tracesSampleRate:0 does not
    // prevent this — the undici instrumentation runs regardless.
    const result = scrub({
      breadcrumbs: [
        {
          message: 'HTTP GET',
          data: {
            url: 'https://portal.example.com/api/devices',
            'http.query': '?token=SUPERSECRET_abc123&api_key=KEY_xyz',
            'http.fragment': '#section-private',
            'http.method': 'GET',
          },
        },
      ],
    });

    const data = ((result.breadcrumbs ?? [])[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data['http.query']).toBe('[Filtered]');
    expect(data['http.fragment']).toBe('[Filtered]');
    expect(data['http.method']).toBe('GET');
  });

  it('strips query strings from URL-valued crumb keys', () => {
    const result = scrub({
      breadcrumbs: [{ data: { url: 'https://hub.local/apps?q=private', from: '/a?x=1', to: '/b#frag' } }],
    });

    const data = ((result.breadcrumbs ?? [])[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.url).toBe('https://hub.local/apps');
    expect(data.from).toBe('/a');
    expect(data.to).toBe('/b');
  });

  it('strips query strings from URL-valued breadcrumb data', () => {
    const event = {
      breadcrumbs: [{ category: 'http', data: { url: '/api/store/search?q=private+app', status_code: 500 } }],
    };

    const [breadcrumb] = scrub(event).breadcrumbs ?? [];

    expect(breadcrumb?.data?.url).toBe('/api/store/search');
    expect(breadcrumb?.data?.status_code).toBe(500);
  });
});
