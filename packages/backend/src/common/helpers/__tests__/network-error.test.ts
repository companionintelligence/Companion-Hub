import net from 'node:net';
import axios, { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed, connectFailure, everyAddressFailed } from '@/tests/utils/network-failures';
import { describeNetworkError } from '../network-error';

/** A Portal request's config, holding the secrets an axios error carries along with it. */
function pairingRequestConfig(): InternalAxiosRequestConfig {
  return {
    url: 'https://portal.example.com/api/devices/pair',
    method: 'post',
    headers: new AxiosHeaders({ 'x-device-key': 'device-key-secret', Authorization: 'Bearer device-key-secret' }),
    data: JSON.stringify({ pairing_code: 'PAIR42', device_key: 'device-key-secret', move_key: 'move-key-secret' }),
  };
}

describe('describeNetworkError', () => {
  it('names each address Node tried when none of them accepted the connection', () => {
    const error = everyAddressFailed();

    // The message the old log lines printed.
    expect(error.message).toBe('');
    expect(describeNetworkError(error)).toBe(EVERY_ADDRESS_FAILED);
  });

  it('looks through the axios error that wraps it, and never prints the request', () => {
    const error = AxiosError.from(everyAddressFailed(), undefined, pairingRequestConfig());

    // axios copies the empty message and the first attempt's code, and keeps the reasons on `cause`.
    expect(error.message).toBe('');
    expect(error.code).toBe('ETIMEDOUT');

    const described = describeNetworkError(error);
    expect(described).toBe(EVERY_ADDRESS_FAILED);
    for (const secret of ['device-key-secret', 'move-key-secret', 'PAIR42', 'portal.example.com', '/api/devices/pair']) {
      expect(described).not.toContain(secret);
    }
  });

  it('gives the hand-built fixture the same answer as the real axios error', () => {
    // Suites that mock axios whole cannot call `AxiosError.from`, so they use the fixture instead.
    const real = AxiosError.from(everyAddressFailed(), undefined, pairingRequestConfig());
    const fixture = axiosEveryAddressFailed();

    expect({ message: fixture.message, name: fixture.name, code: fixture.code, isAxiosError: fixture.isAxiosError }).toEqual({
      message: real.message,
      name: real.name,
      code: real.code,
      isAxiosError: real.isAxiosError,
    });
    expect(fixture.cause).toEqual(real.cause);
    expect(describeNetworkError(fixture)).toBe(describeNetworkError(real));
  });

  it('looks through more than one wrapper', () => {
    const wrapped = new Error('PORTAL_UNREACHABLE', { cause: AxiosError.from(everyAddressFailed(), undefined, pairingRequestConfig()) });

    expect(describeNetworkError(wrapped)).toBe(EVERY_ADDRESS_FAILED);
  });

  it('describes the error a real connection attempt raises when no address accepts it', async () => {
    // A port that was just free on loopback refuses at once, so no timer is involved.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Two addresses for one name, the way DNS answers for the Portal, so Node tries each in turn.
    const lookup = (_hostname: string, _options: unknown, callback: (error: null, addresses: net.LookupAddress[]) => void) =>
      callback(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ]);
    const error = await axios.get(`http://portal.example.test:${port}/api/store`, { lookup: lookup as never, timeout: 5_000 }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(axios.isAxiosError(error)).toBe(true);
    const attempts = ((error as AxiosError).cause as AggregateError).errors as Array<{ code: string; address: string; port: number }>;
    expect(attempts).toHaveLength(2);
    // `::1` refuses too on a host with IPv6; on one without, its own code is listed instead.
    expect(describeNetworkError(error)).toBe(`ECONNREFUSED 127.0.0.1:${port}, ${attempts[1]?.code} [::1]:${port}`);
  });

  it('describes a name that does not resolve', () => {
    const lookupFailure = Object.assign(new Error('getaddrinfo ENOTFOUND portal.example.com'), {
      errno: -3008,
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'portal.example.com',
    });

    expect(describeNetworkError(lookupFailure)).toBe('getaddrinfo ENOTFOUND portal.example.com');
    expect(describeNetworkError(AxiosError.from(lookupFailure, undefined, pairingRequestConfig()))).toBe('getaddrinfo ENOTFOUND portal.example.com');
  });

  it('describes a connection refused on the one address a name has', () => {
    const refused = connectFailure('ECONNREFUSED', '192.0.2.10');

    expect(describeNetworkError(AxiosError.from(refused, undefined, pairingRequestConfig()))).toBe('connect ECONNREFUSED 192.0.2.10:443');
  });

  it("adds the code to axios's own deadline, which has no socket error under it", () => {
    expect(describeNetworkError(new AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED', pairingRequestConfig()))).toBe(
      'timeout of 5000ms exceeded (ECONNABORTED)',
    );
  });

  it("takes a fetch failure's code from what it wraps", () => {
    const headersTimeout = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });

    expect(describeNetworkError(new TypeError('fetch failed', { cause: headersTimeout }))).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)');
    expect(describeNetworkError(new TypeError('fetch failed', { cause: everyAddressFailed() }))).toBe(EVERY_ADDRESS_FAILED);
  });

  it('describes any other error by its message', () => {
    expect(describeNetworkError(new Error('boom'))).toBe('boom');
    expect(describeNetworkError(new RangeError(''))).toBe('RangeError');
  });

  it('describes a thrown value that is not an error', () => {
    expect(describeNetworkError('connection reset by peer')).toBe('connection reset by peer');
    expect(describeNetworkError(503)).toBe('503');
    expect(describeNetworkError(undefined)).toBe('unknown error');
    expect(describeNetworkError(null)).toBe('unknown error');
    // Not serialized: a thrown object can hold anything, and a log line must not.
    expect(describeNetworkError({ status: 503, token: 'thrown-object-secret' })).toBe('unknown error');
  });

  it('scrubs credentials out of a message', () => {
    const described = describeNetworkError(new Error('connect to postgres://hub:db-password@ci-hub-db:5432 failed with token=abc123'));

    expect(described).not.toContain('db-password');
    expect(described).not.toContain('abc123');
    expect(described).toContain('[Filtered]');
  });

  it('keeps a description to one bounded line', () => {
    const described = describeNetworkError(new Error(`first line\nsecond line ${'x'.repeat(1_000)}`));

    expect(described).not.toContain('\n');
    expect(described.startsWith('first line second line')).toBe(true);
    expect(described.length).toBeLessThanOrEqual(300);
  });

  it('counts the addresses past the first eight instead of listing them', () => {
    const attempts = Array.from({ length: 12 }, (_, index) => connectFailure('ETIMEDOUT', `192.0.2.${index + 1}`));

    expect(describeNetworkError(new AggregateError(attempts, ''))).toBe(
      `${attempts
        .slice(0, 8)
        .map((attempt) => `ETIMEDOUT ${attempt.address}:443`)
        .join(', ')}, and 4 more`,
    );
  });

  it('stops on an error that wraps itself', () => {
    const loop = new Error('') as Error & { cause?: unknown; code?: string };
    loop.cause = loop;
    loop.code = 'ELOOP';
    const aggregate = new AggregateError([], '');
    (aggregate as AggregateError & { errors: unknown[] }).errors = [aggregate];

    expect(describeNetworkError(loop)).toBe('ELOOP');
    expect(describeNetworkError(aggregate)).toBe('AggregateError');
  });
});
