import { describe, expect, it, vi } from 'vitest';
import { AuthRateLimiter, authClientKey } from '../auth-rate-limiter';

vi.mock('@/common/helpers/this-host-address', async (importOriginal) =>
  (await import('@/tests/utils/appliance-host-address')).onAppliance(await importOriginal()),
);

const CLIENT = '203.0.113.7';
const GATEWAY = '172.18.0.1';

function limiterAt(clock: { now: number }) {
  const limiter = new AuthRateLimiter();
  limiter.now = () => clock.now;
  return limiter;
}

const tunnelled = (visitor: string, peer = GATEWAY) => ({ ip: peer, socket: { remoteAddress: peer }, headers: { 'cf-connecting-ip': visitor } });

/** Admit `count` requests to `scope` that all fail, the way wrong guesses do. */
function failTimes(limiter: AuthRateLimiter, scope: Parameters<AuthRateLimiter['admit']>[0], client: string, count: number) {
  for (let i = 0; i < count; i++) limiter.admit(scope, client);
}

describe('AuthRateLimiter', () => {
  describe('failure scopes (login, totp, password-reset token)', () => {
    it('lets a client fail up to the limit and refuses the next attempt', () => {
      const limiter = limiterAt({ now: 1_000_000 });

      failTimes(limiter, 'login', CLIENT, 10);

      expect(() => limiter.admit('login', CLIENT)).toThrow('AUTH_ERROR_RATE_LIMITED');
    });

    it('admits only the limit out of a burst that has not finished yet', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      let admitted = 0;

      // 300 requests arriving together: none has an outcome when the next one is checked.
      for (let i = 0; i < 300; i++) {
        try {
          limiter.admit('login', CLIENT);
          admitted++;
        } catch {
          // refused
        }
      }

      expect(admitted).toBe(10);
    });

    it('answers with 429 and the wait in seconds', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      failTimes(limiter, 'login', CLIENT, 10);
      clock.now += 20_000;

      try {
        limiter.admit('login', CLIENT);
        expect.unreachable();
      } catch (error) {
        const exception = error as { getStatus(): number; getResponse(): { intlParams: { retryAfter: string } } };
        expect(exception.getStatus()).toBe(429);
        // The first failure is 20s old in a 60s window.
        expect(exception.getResponse().intlParams.retryAfter).toBe('40');
      }
    });

    it('does not count successful requests, so a script that signs in repeatedly is never limited', () => {
      const limiter = limiterAt({ now: 1_000_000 });

      for (let i = 0; i < 200; i++) {
        limiter.admit('login', CLIENT)();
      }

      expect(() => limiter.admit('login', CLIENT)).not.toThrow();
    });

    it('gives back only the success’s own slot, so one correct login does not reset the guesses beside it', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      failTimes(limiter, 'login', CLIENT, 9);

      limiter.admit('login', CLIENT)();
      limiter.admit('login', CLIENT);

      // Nine failures plus one more is the limit; the correct login in between bought nothing.
      expect(() => limiter.admit('login', CLIENT)).toThrow('AUTH_ERROR_RATE_LIMITED');
    });

    it('gives a slot back only once', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      failTimes(limiter, 'login', CLIENT, 9);
      const refund = limiter.admit('login', CLIENT);

      refund();
      refund();
      limiter.admit('login', CLIENT);

      expect(() => limiter.admit('login', CLIENT)).toThrow();
    });

    it('lets the client back in when the window has passed', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      failTimes(limiter, 'login', CLIENT, 10);
      expect(() => limiter.admit('login', CLIENT)).toThrow();

      clock.now += 60_001;

      expect(() => limiter.admit('login', CLIENT)).not.toThrow();
    });

    it('keeps one client from using up another one’s allowance', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      failTimes(limiter, 'login', '198.51.100.1', 10);

      expect(() => limiter.admit('login', '198.51.100.1')).toThrow();
      expect(() => limiter.admit('login', CLIENT)).not.toThrow();
    });

    it('keeps one route from using up another route’s allowance', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      failTimes(limiter, 'login', CLIENT, 10);

      expect(() => limiter.admit('login', CLIENT)).toThrow();
      expect(() => limiter.admit('totp', CLIENT)).not.toThrow();
    });
  });

  describe('attempt scopes (register, password-reset request)', () => {
    it('counts every request, successful or not', () => {
      const limiter = limiterAt({ now: 1_000_000 });

      for (let i = 0; i < 5; i++) {
        limiter.admit('register', CLIENT)();
      }

      expect(() => limiter.admit('register', CLIENT)).toThrow('AUTH_ERROR_RATE_LIMITED');
    });

    it('is not undone by a success', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      failTimes(limiter, 'passwordResetRequest', CLIENT, 3);

      limiter.admit('passwordResetRequest', CLIENT)();
      limiter.admit('passwordResetRequest', CLIENT);

      expect(() => limiter.admit('passwordResetRequest', CLIENT)).toThrow();
    });

    it('does not count a refused request again', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      failTimes(limiter, 'register', CLIENT, 5);

      // Hammering while blocked must not push the release time out.
      for (let i = 0; i < 50; i++) expect(() => limiter.admit('register', CLIENT)).toThrow();
      clock.now += 60_001;

      expect(() => limiter.admit('register', CLIENT)).not.toThrow();
    });
  });

  it('bounds how many clients it remembers', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 12_000; i++) {
      limiter.admit('login', `2001:db8::${i}`);
      clock.now += 1;
    }

    const tracked = (limiter as unknown as { hits: Map<string, number[]> }).hits.size;
    expect(tracked).toBeLessThanOrEqual(10_001);
  });
});

describe('AuthRateLimiter.admitRequest', () => {
  it('gives each visitor through the tunnel their own budget, and leaves the machine out of it', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(CLIENT));

    expect(() => limiter.admitRequest('login', tunnelled(CLIENT))).toThrow('AUTH_ERROR_RATE_LIMITED');
    expect(() => limiter.admitRequest('login', tunnelled('198.51.100.20'))).not.toThrow();
    expect(() => limiter.admitRequest('login', { ip: GATEWAY, headers: {} })).not.toThrow();
  });

  it('limits a visitor on IPv6 as their whole /64', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(`2001:db8:aaaa:bbbb::${i + 1}`));

    expect(() => limiter.admitRequest('login', tunnelled('2001:db8:aaaa:bbbb::ffff'))).toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it('ignores the header from anywhere but the gateway: a LAN host cannot name someone else', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(`198.51.100.${i + 1}`, '192.168.1.50'));

    expect(() => limiter.admitRequest('login', tunnelled('198.51.100.200', '192.168.1.50'))).toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it.each(['not-an-address', '203.0.113.7, 198.51.100.1', ''])('falls back to the peer for a header that is not one address (%j)', (header) => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(header));

    expect(() => limiter.admitRequest('login', { ip: GATEWAY, headers: {} })).toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it('limits a header with a zone suffix as the address alone, so a forged one cannot grow the key', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    limiter.admitRequest('login', tunnelled(`::ffff:198.51.100.1%${'a'.repeat(4096)}`));
    limiter.admitRequest('login', tunnelled(`2001:db8:aaaa:bbbb::1%${'b'.repeat(4096)}`));

    const tracked = [...(limiter as unknown as { hits: Map<string, number[]> }).hits.keys()];

    expect(tracked).toContain('login:tunnel:198.51.100.1');
    expect(tracked).toContain('login:tunnel:2001:db8:aaaa:bbbb::/64');
    expect(tracked.every((key) => key.length < 64)).toBe(true);
  });

  it.each([
    ['a LAN client', '192.168.1.50'],
    ['the machine', GATEWAY],
  ])('does not spend the budget of %s when the header names its address', (_who, address) => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(address));

    expect(() => limiter.admitRequest('login', { ip: address, socket: { remoteAddress: address }, headers: {} })).not.toThrow();
  });

  it('reads the socket for the peer, not the address a forwarded header can set', () => {
    const limiter = limiterAt({ now: 1_000_000 });
    const claimsGateway = (visitor: string) => ({ ip: GATEWAY, socket: { remoteAddress: '192.168.1.50' }, headers: { 'cf-connecting-ip': visitor } });

    for (let i = 0; i < 10; i++) limiter.admitRequest('login', claimsGateway(`198.51.100.${i + 1}`));

    expect(() => limiter.admitRequest('login', claimsGateway('198.51.100.200'))).toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it('keeps the shared pool spent when the table fills up with live clients', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 100; i++) limiter.admitRequest('login', tunnelled(`198.51.0.${(i % 250) + 1}`));
    for (let i = 0; i < 10_500; i++) limiter.admit('login', `2001:db8:0:${i.toString(16)}::/64`);

    expect(() => limiter.admitRequest('login', tunnelled('203.0.113.200'))).toThrow('AUTH_ERROR_RATE_LIMITED');
  });

  it('caps everyone named by the header together, so inventing addresses does not buy unlimited guesses', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 100; i++) limiter.admitRequest('login', tunnelled(`198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`));

    expect(() => limiter.admitRequest('login', tunnelled('203.0.113.200'))).toThrow('AUTH_ERROR_RATE_LIMITED');
    // The machine itself is not in that pool.
    expect(() => limiter.admitRequest('login', { ip: GATEWAY, headers: {} })).not.toThrow();
  });

  it("gives back a refused request's slot in neither budget", () => {
    const limiter = limiterAt({ now: 1_000_000 });

    for (let i = 0; i < 100; i++) limiter.admitRequest('login', tunnelled(`198.51.0.${(i % 250) + 1}`));
    expect(() => limiter.admitRequest('login', tunnelled(CLIENT))).toThrow('AUTH_ERROR_RATE_LIMITED');

    const tracked = (limiter as unknown as { hits: Map<string, number[]> }).hits;

    expect(tracked.has(`login:tunnel:${CLIENT}`)).toBe(false);
  });

  it('hands back both budgets when a request succeeds', () => {
    const limiter = limiterAt({ now: 1_000_000 });

    // More than the pool holds, so a slot the pool kept would surface here too.
    for (let i = 0; i < 101; i++) limiter.admitRequest('login', tunnelled(CLIENT))();

    expect(() => {
      for (let i = 0; i < 10; i++) limiter.admitRequest('login', tunnelled(CLIENT));
    }).not.toThrow();
  });
});

describe('authClientKey', () => {
  it('uses an IPv4 address as it is', () => {
    expect(authClientKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address it wraps', () => {
    expect(authClientKey({ ip: '::ffff:203.0.113.7' })).toBe('203.0.113.7');
  });

  it('limits an IPv6 client as its whole /64, so a host cannot rotate through its own range', () => {
    const first = authClientKey({ ip: '2001:db8:aaaa:bbbb:1111:2222:3333:4444' });
    const second = authClientKey({ ip: '2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff' });
    const neighbour = authClientKey({ ip: '2001:db8:aaaa:bbbc::1' });

    expect(first).toBe(second);
    expect(first).not.toBe(neighbour);
  });

  it('writes a compressed address and its expanded form the same way', () => {
    expect(authClientKey({ ip: '2001:db8::1' })).toBe(authClientKey({ ip: '2001:0db8:0000:0000:0000:0000:0000:0002' }));
    expect(authClientKey({ ip: '2001:DB8::1' })).toBe(authClientKey({ ip: '2001:db8::1' }));
  });

  it('handles the loopback and the unspecified address', () => {
    expect(authClientKey({ ip: '::1' })).toBe('0:0:0:0::/64');
    expect(authClientKey({ ip: '::' })).toBe('0:0:0:0::/64');
  });

  it('drops a zone id', () => {
    expect(authClientKey({ ip: 'fe80::1%en0' })).toBe(authClientKey({ ip: 'fe80::2' }));
  });

  it('falls back to the socket address, then to a constant', () => {
    expect(authClientKey({ socket: { remoteAddress: '198.51.100.2' } })).toBe('198.51.100.2');
    expect(authClientKey({})).toBe('unknown');
  });
});
