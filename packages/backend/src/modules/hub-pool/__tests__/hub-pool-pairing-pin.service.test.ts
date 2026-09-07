import { randomInt } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { HubPoolPairingPinService, PAIRING_PIN_MAX_ATTEMPTS, PAIRING_PIN_TTL_MS } from '../hub-pool-pairing-pin.service';

// The service destructures its import, so a spy on the crypto namespace object would never be seen.
// Mocking the module is the only way to assert WHICH primitive the PIN comes from — and that is
// worth asserting: `randomBytes(n) % 1e6` is modulo-biased and looks identical at a glance.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const randomIntMock = vi.mocked(randomInt);

const SOURCE = { claimedFqdn: 'hub-b.example-tailnet.ts.net', ip: '100.64.0.2' };

describe('HubPoolPairingPinService', () => {
  let now: number;
  let service: HubPoolPairingPinService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    randomIntMock.mockClear();
    service = new HubPoolPairingPinService(mock<LoggerService>()).withClock(() => now);
  });

  /** Burn a fresh source's cooldown budget without disturbing the one under test. */
  function wrongGuess(pin = '000000', source: { claimedFqdn?: string; ip?: string } = SOURCE): unknown {
    try {
      service.consume(pin, source);
      return null;
    } catch (error) {
      return error;
    }
  }

  describe('minting', () => {
    it('produces six digits from randomInt, not a modulo-biased randomBytes', () => {
      const { pin } = service.mint();

      expect(pin).toMatch(/^\d{6}$/);
      // `randomBytes(n) % 1e6` is biased; asserting the source is what stops it creeping back.
      expect(randomIntMock).toHaveBeenCalledWith(0, 1_000_000);
    });

    it('zero-pads, so a low draw is still a six-digit PIN', () => {
      randomIntMock.mockReturnValueOnce(42 as never);

      expect(service.mint().pin).toBe('000042');
    });

    it('keeps exactly one PIN alive: minting replaces the previous one', () => {
      const first = service.mint();
      const second = service.mint();

      expect(() => service.consume(first.pin, SOURCE)).toThrow(UnauthorizedException);
      expect(() => service.consume(second.pin, SOURCE)).not.toThrow();
    });

    it('reports that a PIN is outstanding and when it expires — never the digits', () => {
      const { pin, expiresAt } = service.mint();

      const state = service.state();

      expect(state).toEqual({ active: true, expiresAt });
      expect(JSON.stringify(state)).not.toContain(pin);
      expect(Date.parse(expiresAt) - now).toBe(PAIRING_PIN_TTL_MS);
    });

    it('cancels on request, which is the operator closing the window early', () => {
      const { pin } = service.mint();

      service.cancel();

      expect(service.state().active).toBe(false);
      expect(() => service.consume(pin, SOURCE)).toThrow(UnauthorizedException);
    });
  });

  describe('consuming', () => {
    it('accepts the right PIN exactly once', () => {
      const { pin } = service.mint();

      expect(() => service.consume(pin, SOURCE)).not.toThrow();
      // Single use: a shoulder-surfed PIN must not pair a second, unwanted node inside the window.
      expect(() => service.consume(pin, SOURCE)).toThrow(UnauthorizedException);
    });

    it('destroys the PIN after the attempt ceiling, so one PIN is worth 5 guesses in 10^6', () => {
      const { pin } = service.mint();

      for (let attempt = 0; attempt < PAIRING_PIN_MAX_ATTEMPTS; attempt += 1) {
        expect(wrongGuess('999999', { claimedFqdn: `attacker-${attempt}.example.ts.net` })).toBeInstanceOf(UnauthorizedException);
      }

      // Even the CORRECT PIN no longer works: the secret itself is the budget.
      expect(() => service.consume(pin, SOURCE)).toThrow(UnauthorizedException);
      expect(service.state().active).toBe(false);
    });

    it('enforces expiry in consume itself, not only in the sweep', () => {
      const { pin } = service.mint();

      now += PAIRING_PIN_TTL_MS;

      // The sweep runs on the health tick, so a ≤30s lag must not leave an expired PIN usable.
      expect(() => service.consume(pin, SOURCE)).toThrow(UnauthorizedException);
    });

    it('sweeps an expired PIN out of memory without needing anyone to try it', () => {
      service.mint();
      now += PAIRING_PIN_TTL_MS + 1;

      service.sweep();

      expect(service.state().active).toBe(false);
    });

    it('answers wrong, expired, already-used and none-outstanding with an IDENTICAL error', () => {
      // This is the test that stops an oracle creeping back in: telling a caller whether a PIN is
      // even outstanding makes the 10^6 space searchable in two steps rather than one.
      const noneOutstanding = wrongGuess('123456', { claimedFqdn: 'a.example.ts.net' });

      const { pin } = service.mint();
      const wrong = wrongGuess('999999', { claimedFqdn: 'b.example.ts.net' });

      service.mint();
      now += PAIRING_PIN_TTL_MS;
      const expired = wrongGuess(pin, { claimedFqdn: 'c.example.ts.net' });

      const { pin: fresh } = service.mint();
      service.consume(fresh, { claimedFqdn: 'd.example.ts.net' });
      const reused = wrongGuess(fresh, { claimedFqdn: 'e.example.ts.net' });

      const shapes = [noneOutstanding, wrong, expired, reused].map((error) => (error as UnauthorizedException).getResponse());
      expect(shapes[0]).toEqual(shapes[1]);
      expect(shapes[0]).toEqual(shapes[2]);
      expect(shapes[0]).toEqual(shapes[3]);
      expect(JSON.stringify(shapes[0])).toContain('Invalid or expired pairing PIN');
    });
  });

  describe('per-source cooldown', () => {
    it('refuses a source that keeps guessing, with a 429 rather than the uniform 401', () => {
      service.mint();

      wrongGuess('999999');
      wrongGuess('999998');

      // Distinguishable on purpose: this one is about the caller, not about the secret, and an
      // operator whose own retry is being refused has to be able to tell the two apart.
      const cooled = wrongGuess('999997');
      expect(cooled).toBeInstanceOf(HttpException);
      expect((cooled as HttpException).getStatus()).toBe(429);
    });

    it('keys the cooldown on the claimed name AND the source IP, so one dodge is not enough', () => {
      service.mint();
      wrongGuess('999999');
      wrongGuess('999998');

      // Same IP, brand-new claimed name: still refused.
      const renamed = wrongGuess('999997', { claimedFqdn: 'someone-else.example.ts.net', ip: SOURCE.ip });
      expect((renamed as HttpException).getStatus()).toBe(429);
    });

    it('lets an unrelated source through while another is cooling', () => {
      const { pin } = service.mint();
      wrongGuess('999999');
      wrongGuess('999998');

      // A global lockout here would hand an attacker a way to stop the operator pairing at all.
      expect(() => service.consume(pin, { claimedFqdn: 'hub-c.example.ts.net', ip: '100.64.0.3' })).not.toThrow();
    });

    it('expires the cooldown so a source that stops guessing is not punished forever', () => {
      service.mint();
      wrongGuess('999999');
      wrongGuess('999998');
      expect((wrongGuess('999997') as HttpException).getStatus()).toBe(429);

      now += 60_001;

      const { pin } = service.mint();
      expect(() => service.consume(pin, SOURCE)).not.toThrow();
    });

    it('clears a source’s strikes on a success', () => {
      service.mint();
      wrongGuess('999999');
      const { pin } = service.mint();
      service.consume(pin, SOURCE);

      service.mint();
      // The single earlier strike was cleared, so this one does not trip the threshold.
      expect(wrongGuess('999999')).toBeInstanceOf(UnauthorizedException);
    });
  });
});
