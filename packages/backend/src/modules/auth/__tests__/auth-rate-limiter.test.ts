import { describe, expect, it } from 'vitest';
import { AuthRateLimiter } from '../auth-rate-limiter';

const CLIENT = '203.0.113.7';

function limiterAt(clock: { now: number }) {
  const limiter = new AuthRateLimiter();
  limiter.now = () => clock.now;
  return limiter;
}

describe('AuthRateLimiter', () => {
  describe('failure scopes (login, totp, password-reset token)', () => {
    it('lets a client fail up to the limit and refuses the next attempt', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);

      for (let i = 0; i < 10; i++) {
        limiter.assertAllowed('login', CLIENT);
        limiter.recordFailure('login', CLIENT);
      }

      expect(() => limiter.assertAllowed('login', CLIENT)).toThrow('AUTH_ERROR_RATE_LIMITED');
    });

    it('answers with 429 and the wait in seconds', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      for (let i = 0; i < 10; i++) limiter.recordFailure('login', CLIENT);
      clock.now += 20_000;

      try {
        limiter.assertAllowed('login', CLIENT);
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
        limiter.assertAllowed('login', CLIENT);
        limiter.recordSuccess('login', CLIENT);
      }

      expect(() => limiter.assertAllowed('login', CLIENT)).not.toThrow();
    });

    it('forgets earlier failures once the client gets it right', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      for (let i = 0; i < 9; i++) limiter.recordFailure('login', CLIENT);

      limiter.recordSuccess('login', CLIENT);
      for (let i = 0; i < 9; i++) limiter.recordFailure('login', CLIENT);

      expect(() => limiter.assertAllowed('login', CLIENT)).not.toThrow();
    });

    it('lets the client back in when the window has passed', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      for (let i = 0; i < 10; i++) limiter.recordFailure('login', CLIENT);
      expect(() => limiter.assertAllowed('login', CLIENT)).toThrow();

      clock.now += 60_001;

      expect(() => limiter.assertAllowed('login', CLIENT)).not.toThrow();
    });

    it('keeps one client from using up another one’s allowance', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      for (let i = 0; i < 10; i++) limiter.recordFailure('login', '198.51.100.1');

      expect(() => limiter.assertAllowed('login', '198.51.100.1')).toThrow();
      expect(() => limiter.assertAllowed('login', CLIENT)).not.toThrow();
    });

    it('keeps one route from using up another route’s allowance', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      for (let i = 0; i < 10; i++) limiter.recordFailure('login', CLIENT);

      expect(() => limiter.assertAllowed('login', CLIENT)).toThrow();
      expect(() => limiter.assertAllowed('totp', CLIENT)).not.toThrow();
    });
  });

  describe('attempt scopes (register, password-reset request)', () => {
    it('counts every request, successful or not', () => {
      const limiter = limiterAt({ now: 1_000_000 });

      for (let i = 0; i < 5; i++) {
        limiter.assertAllowed('register', CLIENT);
        limiter.recordSuccess('register', CLIENT);
      }

      expect(() => limiter.assertAllowed('register', CLIENT)).toThrow('AUTH_ERROR_RATE_LIMITED');
    });

    it('is not undone by a success', () => {
      const limiter = limiterAt({ now: 1_000_000 });
      for (let i = 0; i < 4; i++) limiter.assertAllowed('passwordResetRequest', CLIENT);

      limiter.recordSuccess('passwordResetRequest', CLIENT);
      limiter.assertAllowed('passwordResetRequest', CLIENT);

      expect(() => limiter.assertAllowed('passwordResetRequest', CLIENT)).toThrow();
    });

    it('does not count a refused request again', () => {
      const clock = { now: 1_000_000 };
      const limiter = limiterAt(clock);
      for (let i = 0; i < 5; i++) limiter.assertAllowed('register', CLIENT);

      // Hammering while blocked must not push the release time out.
      for (let i = 0; i < 50; i++) expect(() => limiter.assertAllowed('register', CLIENT)).toThrow();
      clock.now += 60_001;

      expect(() => limiter.assertAllowed('register', CLIENT)).not.toThrow();
    });
  });

  it('bounds how many clients it remembers', () => {
    const clock = { now: 1_000_000 };
    const limiter = limiterAt(clock);

    for (let i = 0; i < 12_000; i++) {
      limiter.recordFailure('login', `2001:db8::${i}`);
      clock.now += 1;
    }

    const tracked = (limiter as unknown as { hits: Map<string, number[]> }).hits.size;
    expect(tracked).toBeLessThanOrEqual(10_001);
  });
});
