# The in-tree KERI module is frozen

> **Status:** Frozen 2026-10-30. Not interoperable.
> **Rule:** Do not use this module for identifiers that leave this process.
> **Scope:** The seven files in this folder (`cesr`, `said`, `aid`, `tel`, `acdc`, `oobi`, `http-sig`) and the `@ci-hub/common/keri/*` export.
> **Checked by:** `__tests__/reference-vector.test.ts` (this package) and `scripts/__tests__/keri-import-guard.test.ts` (repository root).
> **Who may unfreeze:** the Hub security reviewer together with the owner. See [Who may unfreeze](#who-may-unfreeze).

This module encodes keys, digests, signatures, and key events in a CESR-like and KERI-like shape. For the one published
example that is checked here, the module produces a different string than the published one. A string that looks like a KERI
identifier but is not one reads as proof of a key. Nothing that reads the published formats will read it the same way.

Evidence tags used below: **[V]** verified by a test that runs in this repository. **[I]** implemented here and not
exercised by any run. **[code]** read from the source in this folder. **[docs]** taken from the published specification
text and not exercised by a test here. **UNKNOWN** not established.

## What the freeze changes

- The seven files stay, with their tests. Nothing is deleted, and the `exports["./keri/*"]` entry in `package.json` stays
  because the tests and `tsc` resolve through it.
- No production code imports the module. The one that did, `ForwardAuthIdentityResolver`, no longer builds `did:keri:`
  strings. It returns the issuer and the person's id only. [V: `forward-auth-identity.resolver.test.ts`]
- The three header names `X-CI-Hub-User-AID`, `X-CI-Hub-AID`, and `X-CI-Hub-KEL-Digest` are reserved. The Hub never sets
  them. On a route that uses the `ci-hub` forward-auth middleware, with the current header list, Traefik deletes a
  visitor's own copy of each, so an app behind it does not receive a value. [I: not run against Traefik] An app must still
  ignore these names. A value may be introduced only from a persisted key event log, and only with a signature over it.
- `scripts/__tests__/keri-import-guard.test.ts` fails when non-test source under `packages/*/src` or `scripts/` imports the
  module. The only exception is the standalone round-trip script `scripts/verify-keri-toip.ts`, which exercises the module
  itself.
- The OOBI routes keep answering 503. They were already honest and are not touched.

## The published example for code `B` [V]

The check is one key and one code. The expected string is a constant in the test. The test also builds the expected string
again with its own independent encoder of the published rule, and fails if that encoder does not reproduce the constant, so
the test cannot pass because both sides are wrong in the same way.

| Item                                                               | Value                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Code                                                               | `B`                                                                       |
| Key, 32 bytes, hex                                                 | `694e894769e6c3267e8b477c2590284cd647dd42ef6007d254fce1cd2e9be423`        |
| Published string                                                   | `BGlOiUdp5sMmfotHfCWQKEzWR91C72AH0lT84c0um-Qj`                            |
| The published rule, applied by the independent encoder in the test | `BGlOiUdp5sMmfotHfCWQKEzWR91C72AH0lT84c0um-Qj` (same as published)        |
| `encodeCesrPublicKey(key)` in this module                          | `BaU6JR2nmwyZ-i0d8JZAoTNZH3ULvYAfSVPzhzS6b5CM` (not the published string) |
| `decodeCesrPublicKey(published string)` in this module             | 32 bytes that are not the key                                             |

The published rule, for a 32-byte key:

1. Count the zero bytes to prepend: `(3 - length mod 3) mod 3`. For 32 bytes that is 1.
2. Prepend that many zero bytes to the key.
3. Encode the result as base64url without padding.
4. Drop as many leading characters as you prepended bytes.
5. Prepend the code.

This module skips steps 1, 2, and 4: it writes the code and then the plain base64url of the key. Both forms are 44
characters long, so a length check passes either way, and the two strings differ almost everywhere after the code.

**UNKNOWN:** the section of the published specification that lists this key and string was not recorded when the module was
frozen. The independent encoder in the test derives the string from the key by the rule above, so the pair cannot be wrong
without that test failing.

## Known differences

This is what was found when the module was frozen. It is not a conformance audit, so assume there are more.

| Area                | This module                                                                                                                                                                                        | Published                                                                                      | Evidence                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Public key encoding | Code plus plain base64url of the key                                                                                                                                                               | The pre-pad rule above                                                                         | [V] for the example key                                            |
| Public key code     | `B` for every key                                                                                                                                                                                  | `B` is the code of a non-transferable Ed25519 key. A key that can rotate has a code of its own | [docs]. This module rotates keys under `B` [code]                  |
| Digest code         | `E` for a SHA-256 digest                                                                                                                                                                           | `E` is a Blake3-256 digest. SHA-256 has a code of its own                                      | [docs] for the published table, [code] for what this module writes |
| Signature code      | `0A` for an Ed25519 signature                                                                                                                                                                      | The Ed25519 signature code is `0B`. `0A` is a 128-bit salt                                     | [docs] for the published table, [code] for what this module writes |
| Event field order   | Members are sorted alphabetically before an event is hashed and signed (`canonicalStringify` in `said.ts`)                                                                                         | A fixed member order for each event type, which is not alphabetical                            | [code] for the sort, [docs] for the fixed order                    |
| Version string size | The size field is a constant: `KERI10JSON000115_`, `KERI10JSON000135_`, `KERI10JSON0000a0_` in `aid.ts`, `KERI10JSON0000a0_` and `KERI10JSON0000b0_` in `tel.ts`, `ACDC10JSON00019a_` in `acdc.ts` | The size field is the length in bytes of the serialized event, so it changes with the content  | [code] for the constants, [docs] for the meaning of the field      |

If the published entries in the table are right, two consequences follow [inference]. A digest or signature made here would
not be read as one by anything that follows the published formats, and a key event log built here would not be accepted by
anything that follows the published rules.

## Replacement plan

1. Do not repair this module in place. A partial fix makes some strings conform and others not, and that is harder to tell
   apart from a conforming module than a plain failure.
2. Later, replace it with a maintained library that passes the published test vectors, all of them and not only the one
   recorded here. Add each vector it passes to this repository as a test.
3. Create an identifier only from a persisted key event log, never from a label such as a user id, an issuer, or a host name.
   A hash of a public label can be computed by anyone and names no one.
4. Until then the Hub emits no identifier of this kind.

## Who may unfreeze

The Hub security reviewer (the owner assigns the person) together with the owner. Do all of the following in one change:

1. Show that the encoding conforms, or that the module is replaced, by a library or code that passes the published vectors.
2. Flip the expectations in `__tests__/reference-vector.test.ts` so that the encoder now equals the published string. Keep
   the independent encoder and its check.
3. Delete the freeze banner from each file in this folder, and delete this file.
4. Remove the exception for `scripts/verify-keri-toip.ts` from the import guard if the script is gone, and decide on purpose
   which new callers the guard should allow.
5. Update `docs/security/hub-portal-trust.md` and `docs/system/backend.md`, which state that the Hub emits no AID header.
6. If you want the reserved AID headers populated, treat that as a separate change that adds a signature over them and a
   consumer that checks it.
