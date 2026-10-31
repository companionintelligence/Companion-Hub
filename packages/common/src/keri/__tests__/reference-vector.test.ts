import { describe, expect, it } from 'vitest';
import { decodeCesrPublicKey, encodeCesrPublicKey } from '../cesr.js';

/**
 * Why the in-tree KERI module is frozen (FROZEN.md), kept as a check: for the published example of
 * code `B`, this module does not produce the published string.
 *
 * The expectations below record that result. They are meant to fail the day someone makes the
 * encoding conform, so the change goes through the unfreeze review instead of slipping in.
 */

/** A published public test input (a 32-byte Ed25519 key), not a credential. */
const PUBLISHED_INPUT_HEX = '694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423';
const PUBLISHED = 'BGlOiUdp5sMmfotHfCWQKEzWR91C72AH0lT84c0um-Qj';
/** What `encodeCesrPublicKey` returned for that key when the module was frozen, 2026-10-30. */
const RECORDED_AT_FREEZE = 'BaU6JR2nmwyZ-i0d8JZAoTNZH3ULvYAfSVPzhzS6b5CM';

const UNFREEZE =
  'If you made the encoding conform, flip these expectations, delete the freeze banners and FROZEN.md, and read the plan. ' +
  'The plan is in FROZEN.md (Who may unfreeze): read it before you delete the file.';

/**
 * The published rule, written out here on purpose and sharing nothing with the code under test:
 * prepend `(3 - length mod 3) mod 3` zero bytes, encode as base64url, drop that many leading characters, prepend the code.
 */
function publishedEncoding(code: string, raw: Buffer): string {
  const padBytes = (3 - (raw.length % 3)) % 3;
  const padded = Buffer.concat([Buffer.alloc(padBytes), raw]);
  return code + padded.toString('base64url').slice(padBytes);
}

describe('reference vector for CESR code B (the in-tree module is frozen because it does not match)', () => {
  const key = Buffer.from(PUBLISHED_INPUT_HEX, 'hex');

  it('has an independent encoder of the published rule that reproduces the published string, so the checks below cannot pass vacuously', () => {
    expect(key.length).toBe(32);
    expect(publishedEncoding('B', key), 'the independent encoder no longer reproduces the published string: fix it, not the expectations below').toBe(
      PUBLISHED,
    );
  });

  it('records the string the in-tree encoder gives for that key', () => {
    expect(encodeCesrPublicKey(key), UNFREEZE).toBe(RECORDED_AT_FREEZE);
  });

  it('states that the in-tree encoder does not give the published string', () => {
    expect(encodeCesrPublicKey(key), UNFREEZE).not.toBe(PUBLISHED);
  });

  it('decodes the published string to bytes that are not the key', () => {
    expect(decodeCesrPublicKey(PUBLISHED).equals(key), UNFREEZE).toBe(false);
  });
});
