import { beforeEach, describe, expect, it } from 'vitest';

import { appChallengeFor, bindSignInToThisApp, clearAppVerifier, pendingAppVerifier } from './deep-link-app-binding';

const START = 'https://hub.example.com/api/auth/portal/start?desktop=1';

beforeEach(() => localStorage.clear());

describe('binding a sign-in to this app', () => {
  it('adds the challenge of a secret it keeps', async () => {
    const href = await bindSignInToThisApp(START);
    const verifier = pendingAppVerifier();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(href).searchParams.get('app_challenge')).toBe(await appChallengeFor(verifier as string));
    expect(new URL(href).searchParams.get('desktop')).toBe('1');
  });

  it('never puts the secret itself in the URL', async () => {
    const href = await bindSignInToThisApp(START);

    expect(href).not.toContain(pendingAppVerifier() as string);
  });

  it('makes a new secret for every sign-in', async () => {
    await bindSignInToThisApp(START);
    const first = pendingAppVerifier();
    await bindSignInToThisApp(START);

    expect(pendingAppVerifier()).not.toBe(first);
  });

  it('is the standard S256 challenge', async () => {
    // RFC 7636 appendix B.
    expect(await appChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('forgets a secret after thirty minutes, or when told to', async () => {
    const now = Date.now();
    await bindSignInToThisApp(START, now);

    expect(pendingAppVerifier(now + 29 * 60 * 1000)).not.toBeNull();
    expect(pendingAppVerifier(now + 31 * 60 * 1000)).toBeNull();

    clearAppVerifier();
    expect(pendingAppVerifier(now)).toBeNull();
  });
});
