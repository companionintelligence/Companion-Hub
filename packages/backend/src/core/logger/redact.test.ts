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
    for (let i = 0; i < 30; i++) deep = { next: deep };

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
