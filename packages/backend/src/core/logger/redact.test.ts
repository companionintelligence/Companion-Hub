import { describe, expect, it } from 'vitest';
import { REDACTED, redactForLog, redactString } from './redact';

describe('redactForLog', () => {
  it.each([
    'password',
    'Password',
    'newPassword',
    'currentPassword',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'secret',
    'client_secret',
    'apiKey',
    'api_key',
    'x-api-key',
    'deviceKey',
    'device_key',
    'moveKey',
    'privateKey',
    'totpCode',
    'totpSessionId',
    'token',
    'accessToken',
    'refresh_token',
    'x-token',
    'ticket',
    'dsn',
    'signature',
    'sessionId',
    'session_id',
  ])('replaces the value of %s', (key) => {
    expect(redactForLog({ [key]: 'hunter2', other: 'visible' })).toEqual({ [key]: REDACTED, other: 'visible' });
  });

  it.each([
    'max_tokens',
    'inputTokens',
    'outputTokens',
    'tokenCount',
    'tokens',
    'token_usage',
    'status',
    'urn',
    'appName',
    'code',
    'keyword',
    'author',
  ])('leaves the value of %s alone', (key) => {
    expect(redactForLog({ [key]: 123 })).toEqual({ [key]: 123 });
  });

  it('reaches into nested objects and arrays', () => {
    const result = redactForLog({
      request: { headers: { Authorization: 'Bearer abc.def', accept: 'application/json' }, body: [{ password: 'p' }, { name: 'n' }] },
    });

    expect(result).toEqual({
      request: { headers: { Authorization: REDACTED, accept: 'application/json' }, body: [{ password: REDACTED }, { name: 'n' }] },
    });
  });

  it('masks credential-shaped strings under harmless keys', () => {
    expect(redactForLog({ note: 'sent Bearer abc.def.ghi to the portal', url: 'https://x.test/cb?code=abc123&state=ok' })).toEqual({
      note: `sent Bearer ${REDACTED} to the portal`,
      url: `https://x.test/cb?code=${REDACTED}&state=ok`,
    });
  });

  it('serialises through toJSON the way JSON.stringify would, then redacts what it produced', () => {
    // The shape of an Axios error: its toJSON() carries the whole request config.
    const axiosLike = {
      message: 'Request failed',
      toJSON() {
        return { message: this.message, config: { url: 'https://portal.test/api', headers: { Authorization: 'Bearer live-secret' } } };
      },
    };

    const text = JSON.stringify(redactForLog({ error: axiosLike }));

    expect(text).not.toContain('live-secret');
    expect(text).toContain('Request failed');
  });

  it('does not recurse forever on a cycle', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;

    expect(redactForLog(a)).toEqual({ name: 'a', self: '[Circular]' });
  });

  it('keeps a value that appears twice without calling it circular', () => {
    const shared = { n: 1 };

    expect(redactForLog({ left: shared, right: shared })).toEqual({ left: { n: 1 }, right: { n: 1 } });
  });

  it('cuts off absurd depth', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { next: deep };

    expect(JSON.stringify(redactForLog(deep))).toContain('[Truncated]');
  });

  it('passes primitives and null through', () => {
    expect(redactForLog(7)).toBe(7);
    expect(redactForLog(true)).toBe(true);
    expect(redactForLog(null)).toBeNull();
    expect(redactForLog(undefined)).toBeUndefined();
  });

  it('does not mutate what it was given', () => {
    const input = { password: 'p', nested: { token: 't' } };

    redactForLog(input);

    expect(input).toEqual({ password: 'p', nested: { token: 't' } });
  });
});

describe('redactString', () => {
  it('masks a bearer credential', () => {
    expect(redactString('Authorization: Bearer eyJhbGciOi.payload.sig== failed')).toBe(`Authorization: Bearer ${REDACTED} failed`);
  });

  it('masks a Tailscale auth key', () => {
    expect(redactString('joining with tskey-auth-k123-abcDEF')).toBe(`joining with ${REDACTED}`);
  });

  it('masks the password in a connection URL and keeps the rest', () => {
    expect(redactString('connect postgres://companion:s3cret@db.internal:5432/companiondb failed')).toBe(
      `connect postgres://${REDACTED}@db.internal:5432/companiondb failed`,
    );
  });

  it.each(['token', 'access_token', 'api_key', 'password', 'session_id', 'sig', 'ticket', 'code'])('masks ?%s= in a URL', (param) => {
    expect(redactString(`GET /cb?${param}=abc123&keep=1`)).toBe(`GET /cb?${param}=${REDACTED}&keep=1`);
  });

  it('leaves ordinary prose, including the words token and password, exactly as written', () => {
    const line = 'token expired for the password reset flow; retrying in 30s (user alice@example.com, /home/alice/data)';

    expect(redactString(line)).toBe(line);
  });

  it('leaves a URL without credentials alone', () => {
    expect(redactString('GET https://hub.example.com/api/apps?page=2&sort=name')).toBe('GET https://hub.example.com/api/apps?page=2&sort=name');
  });
});

describe('redactString on hostile input', () => {
  it.each([
    ['dash-separated words', 'a-'.repeat(32 * 1024)],
    ['dot-separated words', 'a.'.repeat(32 * 1024)],
    ['plus signs', 'a+'.repeat(32 * 1024)],
    ['a long run of the user-info alphabet', 'a'.repeat(64 * 1024)],
    ['many scheme-like starts', 'ab://a:'.repeat(8 * 1024)],
    ['unterminated JSON strings', '{"password": "'.repeat(4 * 1024)],
    ['unterminated environment values', 'DB_PASSWORD='.repeat(8 * 1024)],
  ])('takes linear time on %s', (_name, body) => {
    const started = performance.now();

    redactString(body);

    // 64 KB of `a-a-a-…` took five seconds when the scheme was unbounded; linear work is a few ms.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('redactString on serialised documents', () => {
  it('redacts by key inside a JSON document held in a string, as an HTTP client error carries a request body', () => {
    const body = JSON.stringify({ email: 'a@b.c', password: 'hunter2', deviceKey: 'dk-123', nested: { apiKey: 'sk-live' }, max_tokens: 5 });

    const redacted = JSON.parse(redactString(body));

    expect(redacted).toEqual({ email: 'a@b.c', password: REDACTED, deviceKey: REDACTED, nested: { apiKey: REDACTED }, max_tokens: 5 });
  });

  it('redacts a request body held in an Axios-shaped error config', () => {
    const error = {
      message: 'Request failed',
      config: { url: '/login', data: JSON.stringify({ password: 'hunter2' }), headers: { Authorization: 'Bearer abc' } },
    };

    expect(JSON.stringify(redactForLog(error))).not.toMatch(/hunter2|Bearer abc/);
  });

  it('redacts a JSON fragment embedded in a message', () => {
    const redacted = redactString('upstream said 401 for {"user":"alice","password":"hunter2","token":"abc.def"} twice');

    expect(redacted).toBe(`upstream said 401 for {"user":"alice","password":"${REDACTED}","token":"${REDACTED}"} twice`);
  });

  it('leaves a quoted word that only resembles a credential name alone', () => {
    const line = 'options {"max_tokens": "5", "tokenizer": "llama", "shipping": "now"}';

    expect(redactString(line)).toBe(line);
  });

  it('redacts the value of an environment assignment, as a container Env listing prints it', () => {
    const redacted = redactString('Env: ["ADMIN_PASSWORD=hunter2","SAMBA_PASS=open","API_KEY=sk-live","TZ=UTC","MAX_TOKENS=500"]');

    expect(redacted).toBe(`Env: ["ADMIN_PASSWORD=${REDACTED}","SAMBA_PASS=${REDACTED}","API_KEY=${REDACTED}","TZ=UTC","MAX_TOKENS=500"]`);
  });

  it('leaves a string that only looks like JSON alone', () => {
    expect(redactString('{ not json')).toBe('{ not json');
  });
});

describe('redactForLog keys and values', () => {
  it.each(['hubLocalKey', 'accessKey', 'passphrase', 'credentials', 'SAMBA_PASS', 'jwt', 'pin', 'ciHubApiKey', 'pwd'])(
    'replaces the value of %s',
    (key) => {
      expect(redactForLog({ [key]: 'hunter2' })).toEqual({ [key]: REDACTED });
    },
  );

  it('keeps a flag, a missing value and an empty string readable under a credential name', () => {
    const input = { totpEnabled: false, passwordSet: true, hasSecret: null, apiKey: '', token: undefined };

    expect(redactForLog(input)).toEqual(input);
  });

  it('replaces a number or an object held under a credential name', () => {
    expect(redactForLog({ pin: 123456, credentials: { user: 'a', pass: 'b' } })).toEqual({ pin: REDACTED, credentials: REDACTED });
  });

  it('keeps an own __proto__ key instead of turning it into a prototype', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": 1}, "kept": 2}');

    const redacted = redactForLog(parsed) as Record<string, unknown>;

    expect(Object.keys(redacted)).toEqual(['__proto__', 'kept']);
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });

  it('reaches a compose tree nested deeper than eight levels', () => {
    let tree: Record<string, unknown> = { deviceKey: 'dk', leaf: 'kept' };
    for (let level = 0; level < 12; level++) tree = { child: tree };

    let walked: any = redactForLog(tree);
    for (let level = 0; level < 12; level++) walked = walked.child;

    expect(walked).toEqual({ deviceKey: REDACTED, leaf: 'kept' });
  });
});
