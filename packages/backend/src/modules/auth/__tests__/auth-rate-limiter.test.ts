import { describe, expect, it } from 'vitest';
import { AuthRateLimiter, authClientKey } from '../auth-rate-limiter';

const CLIENT = '203.0.113.7';

function limiterAt(clock: { now: number }) {
  const limiter = new AuthRateLimiter();
  limiter.now = () => clock.now;
  return limiter;
}

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
