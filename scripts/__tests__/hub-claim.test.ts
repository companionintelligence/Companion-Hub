/**
 * Reading a Hub's answer to a claim.
 *
 * Three different conditions share HTTP 409 — not registered, already claimed, and (from any
 * guarded route) not claimed at all — so the status code is not enough to decide what to tell the
 * operator. The translation key is, and it is the one part of the answer that does not change with
 * wording or locale. Getting this parse wrong is how "already claimed" becomes a failed install.
 */

import { describe, expect, it } from 'vitest';
import { isValidClaimEmail, parseHubClaimError } from '../lib/hub-claim.js';

describe('parseHubClaimError', () => {
  it('lifts the translation key out of a Hub refusal', () => {
    // `MainExceptionFilter` renders every TranslatableError as { statusCode, message, path }, where
    // `message` IS the key.
    const refused = parseHubClaimError(
      409,
      JSON.stringify({ statusCode: 409, message: 'AUTH_ERROR_HUB_ALREADY_CLAIMED', path: '/api/auth/hub/claim' }),
    );

    expect(refused.code).toBe('AUTH_ERROR_HUB_ALREADY_CLAIMED');
    expect(refused.status).toBe(409);
  });

  it('does not mistake ordinary prose for a key', () => {
    // A key is SHOUT_CASE by construction. Treating a sentence as one would let a proxy's error
    // text steer the CLI's branching.
    const refused = parseHubClaimError(500, JSON.stringify({ message: 'Something went wrong' }));

    expect(refused.code).toBeUndefined();
    expect(refused.message).toBe('Something went wrong');
  });

  it('keeps a non-JSON body as the message instead of throwing', () => {
    // An HTML error page from a proxy in front of the Hub is a real answer worth showing; a parse
    // crash here would replace it with a stack trace.
    const refused = parseHubClaimError(502, '<html><body>Bad Gateway</body></html>');

    expect(refused.code).toBeUndefined();
    expect(refused.message).toContain('Bad Gateway');
  });

  it('always has something to say, even for an empty body', () => {
    expect(parseHubClaimError(503, '').message).toContain('503');
  });
});

describe('isValidClaimEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidClaimEmail('owner@example.com')).toBe(true);
    expect(isValidClaimEmail('  owner@example.com  ')).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['owner', 'no domain'],
    ['owner@example', 'no dot'],
    ['own er@example.com', 'a space'],
    ['owner@@example.com', 'two @'],
  ])('refuses %s (%s)', (value) => {
    expect(isValidClaimEmail(value)).toBe(false);
  });

  it('refuses an absurdly long address rather than posting it', () => {
    expect(isValidClaimEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});
