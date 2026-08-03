import { describe, expect, it } from 'vitest';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { scrubEvent, scrubString, scrubUrl } from './sentry-scrubber';

/** `scrubEvent` needs a hint; none of the cases below are transient-DB noise. */
const scrub = (event: unknown) => scrubEvent(event as never, {} as never);

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

    for (const [key, value] of Object.entries(result?.extra ?? {})) {
      expect(value, `${key} was not filtered`).toBe('[Filtered]');
    }
  });

  it('keeps diagnostic keys that merely look identity-ish', () => {
    const result = scrub({
      extra: { 'user-agent': 'curl/8.0', user_id: 'abc', owner_id: 'def', http_status: 500 },
    });

    expect(result?.extra).toEqual({ 'user-agent': 'curl/8.0', user_id: 'abc', owner_id: 'def', http_status: 500 });
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

    const request = result?.request as Record<string, unknown>;
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

  it('drops the machine hostname', () => {
    expect(scrub({ server_name: 'MacBook-Pro-2.local' })?.server_name).toBeUndefined();
  });

  it('keeps user.id but drops every other user identifier', () => {
    const result = scrub({
      user: { id: 'device-abc', ip_address: '203.0.113.42', email: 'liam@example.com', username: 'liam' },
    });

    expect(result?.user).toEqual({ id: 'device-abc' });
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

    const frame = (result?.exception?.values?.[0]?.stacktrace?.frames ?? [])[0] as Record<string, unknown>;
    expect(frame.filename).not.toContain('/Users/liam');
    expect(frame.abs_path).not.toContain('/Users/liam');
    expect(frame.context_line).not.toContain('ci_hub_9f3a7c21be40');
    expect((frame.pre_context as string[])[0]).not.toContain('/Users/liam');
    expect((frame.post_context as string[])[0]).not.toContain('SUPERSECRET');
    // A bare value under a sensitive key is caught by the key check.
    expect((frame.vars as Record<string, unknown>).token).toBe('[Filtered]');
    expect((frame.vars as Record<string, unknown>).path).not.toContain('/Users/liam');
  });
});

describe('breadcrumbs', () => {
  it('walks data as a whole object so bare credentials under sensitive keys are caught', () => {
    // Scrubbing each value individually would miss this: `bare-secret-value`
    // matches no secret pattern, and only the KEY identifies it.
    const result = scrub({
      breadcrumbs: [{ message: 'fetch /Users/liam/x', data: { token: 'bare-secret-value' } }],
    });

    const crumb = (result?.breadcrumbs ?? [])[0] as Record<string, unknown>;
    expect((crumb.data as Record<string, unknown>).token).toBe('[Filtered]');
    expect(crumb.message).not.toContain('/Users/liam');
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

    const data = ((result?.breadcrumbs ?? [])[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data['http.query']).toBe('[Filtered]');
    expect(data['http.fragment']).toBe('[Filtered]');
    expect(data['http.method']).toBe('GET');
  });

  it('strips query strings from URL-valued crumb keys', () => {
    const result = scrub({
      breadcrumbs: [{ data: { url: 'https://hub.local/apps?q=private', from: '/a?x=1', to: '/b#frag' } }],
    });

    const data = ((result?.breadcrumbs ?? [])[0] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.url).toBe('https://hub.local/apps');
    expect(data.from).toBe('/a');
    expect(data.to).toBe('/b');
  });
});

describe('scrubUrl', () => {
  it('strips query and fragment without touching the path', () => {
    expect(scrubUrl('https://hub.local/api/apps?q=x#f')).toBe('https://hub.local/api/apps');
    expect(scrubUrl('/api/apps')).toBe('/api/apps');
  });
});

describe('scrubString extras', () => {
  it('redacts credentials embedded in connection strings', () => {
    expect(scrubString('postgres://ci:hunter2@ci-hub-db:5432/hub')).not.toContain('hunter2');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
    expect(scrubbed.length).toBeLessThan(9000);
  });
});
