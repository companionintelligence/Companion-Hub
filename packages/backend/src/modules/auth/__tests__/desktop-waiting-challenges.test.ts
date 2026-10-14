import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_WAITING_CHALLENGE_CAP, DESKTOP_WAITING_CHALLENGE_TTL_MS, DesktopWaitingChallenges } from '../desktop-waiting-challenges';

function challengesAt(start = 1_000_000) {
  const challenges = new DesktopWaitingChallenges();
  const clock = { now: start };
  challenges.now = () => clock.now;
  return { challenges, clock };
}

describe('DesktopWaitingChallenges', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands out a different 32-byte nonce each time', () => {
    const { challenges } = challengesAt();
    const first = challenges.issue();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(challenges.issue()).not.toBe(first);
  });

  it('takes an open nonce once', () => {
    const { challenges } = challengesAt();
    const nonce = challenges.issue();

    expect(challenges.take(nonce)).toBe(true);
    expect(challenges.take(nonce)).toBe(false);
  });

  it.each([
    ['a nonce it never issued', 'ab'.repeat(32)],
    ['no nonce', undefined],
    ['a repeated header', ['ab'.repeat(32)]],
  ])('refuses %s', (_case, nonce) => {
    const { challenges } = challengesAt();
    challenges.issue();

    expect(challenges.take(nonce)).toBe(false);
  });

  it('refuses a nonce once it has expired, and forgets it', () => {
    const { challenges, clock } = challengesAt();
    const nonce = challenges.issue();

    clock.now += DESKTOP_WAITING_CHALLENGE_TTL_MS + 1;

    expect(challenges.take(nonce)).toBe(false);
    clock.now -= DESKTOP_WAITING_CHALLENGE_TTL_MS + 1;
    expect(challenges.take(nonce)).toBe(false);
  });

  it('still takes a nonce at the end of its life', () => {
    const { challenges, clock } = challengesAt();
    const nonce = challenges.issue();

    clock.now += DESKTOP_WAITING_CHALLENGE_TTL_MS;

    expect(challenges.take(nonce)).toBe(true);
  });

  it('ignores the wall clock, which a WSL VM steps forward when it catches up after sleep', () => {
    let wall = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const challenges = new DesktopWaitingChallenges();
    const nonce = challenges.issue();

    wall += 2 * 60 * 60 * 1000;

    expect(challenges.take(nonce)).toBe(true);
  });

  it(`keeps at most ${DESKTOP_WAITING_CHALLENGE_CAP} open, dropping the oldest`, () => {
    const { challenges, clock } = challengesAt();
    const issued: string[] = [];
    for (let i = 0; i <= DESKTOP_WAITING_CHALLENGE_CAP; i += 1) {
      issued.push(challenges.issue());
      clock.now += 1;
    }

    expect(challenges.take(issued[0])).toBe(false);
    expect(challenges.take(issued[1])).toBe(true);
    expect(challenges.take(issued[DESKTOP_WAITING_CHALLENGE_CAP])).toBe(true);
  });
});
