import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { HttpStatus, Injectable } from '@nestjs/common';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { ForwardAuthIdentityResolver } from './forward-auth-identity.resolver';
import { didKeyPublicKey, isDidKey } from './utils/did-key';

/**
 * Sign in with a DID: the Hub half of ADR-0016 (Local.Pub alongside KERI).
 *
 * ═══ WHAT IT IS ═══
 *
 * A person whose identity key is an Ed25519 `did:key` proves control of it by signing a challenge
 * this Hub issued. Any well-formed Ed25519 `did:key` that is not a weak key is accepted, and nothing
 * here says who can produce one: a Local.Pub account's DID authentication key (a `z6Mk…` Multikey in
 * its DID log) can be written as a `did:key`, but it can rotate, which orphans the link, and whether
 * any Local.Pub client or wallet will sign a Hub challenge is unknown and untested. The proof is a
 * SIOPv2-shaped self-issued ID token, a compact JWS signed with EdDSA:
 *
 *   header   {"alg":"EdDSA","typ":"JWT","kid":"<did>" or "<did>#<fragment>"}     (kid optional)
 *   payload  {"iss":"<did>","sub":"<did>","aud":"<audience>","nonce":"<nonce>","iat":n,"exp":n}
 *
 * `audience`, `nonce` and `purpose` come from {@link DidAuthService.issueChallenge}; `iat`/`exp` are
 * whole Unix seconds, `exp` is after `iat`, and `exp - iat` may not exceed
 * {@link DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS}.
 *
 * ═══ A CHALLENGE HAS ONE PURPOSE ═══
 *
 * Asked for as `sign-in` or `link` and spent on that one thing. A relayed sign-in proof cannot be
 * redeemed as a link (which would bind the signer's DID to the relayer's own person), and a link
 * proof cannot sign anyone in.
 *
 * ═══ WHAT IT DELIBERATELY IS NOT ═══
 *
 * - It creates no person and no binding. A DID signs in only as the person whose signed-in owner
 *   LINKED it first (`link`), as a `federated_identity` row with issuer `did:key`. The Hub has no
 *   authority over identity bindings and derives none from a label, a name or an email.
 * - It emits no identifier of its own. The reserved `X-CI-Hub-*-AID` headers stay unset and forward
 *   auth is untouched; the frozen KERI module is not imported (see packages/common/src/keri/FROZEN.md).
 * - It does not read a key from the token. The verifying key is derived from the DID alone, so a
 *   `jwk`, `jku`, `x5u` or `kid` header can name nothing and select nothing.
 * - It does not resolve DIDs. `did:web`, `did:webvh`, `did:scid:vh` and KERI AIDs can rotate their
 *   keys; reading one means resolving a log, and a verifier that skipped that would accept a key its
 *   owner had retired.
 *
 * Off unless the environment sets {@link DID_AUTH_FLAG} to `true`, read at call time.
 */

/** The environment flag. Anything but the string `true` leaves every DID route absent. */
export const DID_AUTH_FLAG = 'CI_HUB_DID_AUTH';

/** The `federated_identity.issuer` of a DID binding. Its `subject` is the full `did:key:z6Mk…` string. */
export const DID_KEY_ISSUER = 'did:key';

/** How long a challenge can be answered. It is spent by the first proof presented, whatever its fate. */
export const DID_AUTH_CHALLENGE_TTL_SECONDS = 120;

/** The longest validity a proof may claim, whatever its `exp` says. */
export const DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS = 300;

/** How far a signer's clock may be from this Hub's, in seconds. */
export const DID_AUTH_CLOCK_TOLERANCE_SECONDS = 30;

/** What a challenge is for. A proof made for one purpose is refused for the other. */
export type DidAuthPurpose = 'sign-in' | 'link';

const PURPOSES: readonly DidAuthPurpose[] = ['sign-in', 'link'];

const CHALLENGE_PREFIX = 'did-auth:challenge:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_CHARS = 4096;

export interface DidAuthChallenge {
  challengeId: string;
  nonce: string;
  audience: string;
  purpose: DidAuthPurpose;
  /** Unix milliseconds. */
  expiresAt: number;
}

export type DidAuthRefusalReason =
  | 'unknown-challenge'
  | 'wrong-purpose'
  | 'malformed'
  | 'bad-alg'
  | 'bad-did'
  | 'bad-kid'
  | 'bad-signature'
  | 'bad-claims'
  | 'bad-nonce';

/**
 * Why a proof was refused. The reason is for the Hub's own debug log: the caller is told nothing
 * about which check failed, so the response cannot be used to probe them one at a time.
 */
export class DidAuthRefusal extends Error {
  constructor(readonly reason: DidAuthRefusalReason) {
    super(`DID sign-in refused: ${reason}`);
    this.name = 'DidAuthRefusal';
  }
}

@Injectable()
export class DidAuthService {
  /** The clock, in milliseconds. A field rather than a constructor argument so Nest has nothing to inject; tests move it. */
  public now: () => number = Date.now;

  constructor(
    private readonly cache: CacheService,
    private readonly identities: FederatedIdentityRepository,
    private readonly forwardAuth: ForwardAuthIdentityResolver,
    private readonly logger: LoggerService,
  ) {}

  /** Whether the DID routes exist. Read per call, so the flag follows the environment the Hub was started with. */
  get enabled(): boolean {
    return process.env[DID_AUTH_FLAG] === 'true';
  }

  /**
   * A single-use challenge for one purpose. The audience is this Hub's own issuer
   * (`urn:ci-hub:<directory id>`), the name forward auth already signs people under, so a proof made
   * for another Hub, or for Portal, names a different audience and does not verify here.
   *
   * ⚠ The first call on a Hub can WRITE: `hubIssuer` inserts the `user_directory` row if a restore
   * or a factory reset left none, as the first forward-auth call would. The caller is anonymous, so
   * an anonymous request can be the one that creates it. The audience also reaches every anonymous
   * caller: it is the Hub's per-install directory id, the same value forward auth signs for apps.
   */
  async issueChallenge(purpose: DidAuthPurpose = 'sign-in'): Promise<DidAuthChallenge> {
    let audience: string;
    try {
      audience = await this.forwardAuth.hubIssuer();
    } catch (error) {
      this.logger.warn(`DID sign-in could not read this Hub's issuer: ${error instanceof Error ? error.message : String(error)}`);
      throw new TranslatableError('AUTH_ERROR_DID_UNAVAILABLE', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }

    const challengeId = randomUUID();
    // 192 bits. Not a secret from the person who asked, but unguessable by anyone who did not.
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + DID_AUTH_CHALLENGE_TTL_SECONDS * 1000;

    this.cache.set(`${CHALLENGE_PREFIX}${challengeId}`, JSON.stringify({ nonce, audience, purpose, expiresAt }), DID_AUTH_CHALLENGE_TTL_SECONDS);

    return { challengeId, nonce, audience, purpose, expiresAt };
  }

  /**
   * Take a challenge out of the store: read, then delete, in one synchronous step. A challenge can be
   * answered once, even by a proof that then fails, so a captured proof cannot be tried again and a
   * guess at a signature costs a fresh challenge each time.
   */
  consumeChallenge(challengeId: unknown): { nonce: string; audience: string; purpose: DidAuthPurpose } | null {
    // A UUID has no `:`, so an id cannot address another key under the prefix.
    if (typeof challengeId !== 'string' || !UUID_PATTERN.test(challengeId)) {
      return null;
    }

    const key = `${CHALLENGE_PREFIX}${challengeId}`;
    const raw = this.cache.get(key);
    if (!raw) {
      return null;
    }
    this.cache.del(key);

    try {
      const parsed = JSON.parse(raw) as { nonce?: unknown; audience?: unknown; purpose?: unknown; expiresAt?: unknown };
      if (
        typeof parsed.nonce !== 'string' ||
        typeof parsed.audience !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        !PURPOSES.includes(parsed.purpose as DidAuthPurpose)
      ) {
        return null;
      }
      // The cache expires it too; this is the check that does not depend on the cache's clock.
      return parsed.expiresAt > this.now() ? { nonce: parsed.nonce, audience: parsed.audience, purpose: parsed.purpose as DidAuthPurpose } : null;
    } catch {
      return null;
    }
  }

  /**
   * Check a proof against the challenge it answers, for the purpose it was asked for, and return the
   * DID that signed it.
   *
   * Every refusal is a {@link DidAuthRefusal}. The challenge is spent first, so no refusal leaves it
   * available to try again.
   */
  async verify(challengeId: unknown, idToken: unknown, purpose: DidAuthPurpose): Promise<{ did: string }> {
    const challenge = this.consumeChallenge(challengeId);
    if (!challenge) {
      throw new DidAuthRefusal('unknown-challenge');
    }

    // A challenge asked for to sign in is not good for a link, and the reverse. It is spent either way.
    if (challenge.purpose !== purpose) {
      throw new DidAuthRefusal('wrong-purpose');
    }

    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_CHARS) {
      throw new DidAuthRefusal('malformed');
    }

    let header: ReturnType<typeof decodeProtectedHeader>;
    let claimed: ReturnType<typeof decodeJwt>;
    try {
      header = decodeProtectedHeader(idToken);
      claimed = decodeJwt(idToken);
    } catch {
      throw new DidAuthRefusal('malformed');
    }

    // Exactly EdDSA, in the header and again in the verifier below: `none` and every HMAC are not on the list.
    if (header.alg !== 'EdDSA') {
      throw new DidAuthRefusal('bad-alg');
    }

    // The key comes from the DID the token CLAIMS and from nowhere else. Whether the claim is true is
    // what the signature check below answers.
    const did = claimed.iss;
    if (!isDidKey(did)) {
      throw new DidAuthRefusal('bad-did');
    }

    if (header.kid !== undefined && !(typeof header.kid === 'string' && (header.kid === did || header.kid.startsWith(`${did}#`)))) {
      throw new DidAuthRefusal('bad-kid');
    }

    const key = didKeyPublicKey(did);
    if (key == null) {
      throw new DidAuthRefusal('bad-did');
    }

    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      ({ payload } = await jwtVerify(idToken, key, {
        algorithms: ['EdDSA'],
        issuer: did,
        subject: did,
        audience: challenge.audience,
        clockTolerance: DID_AUTH_CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.now()),
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce'],
      }));
    } catch (error) {
      // A bad signature, an expired or mis-addressed token, a claim that does not match: one answer to the caller.
      throw new DidAuthRefusal(error instanceof Error && error.name === 'JWSSignatureVerificationFailed' ? 'bad-signature' : 'bad-claims');
    }

    const { iat, exp, nonce, aud } = payload;
    const nowSeconds = Math.floor(this.now() / 1000);

    // One audience, exactly: a token addressed to several parties is not addressed to this Hub alone.
    if (aud !== challenge.audience) {
      throw new DidAuthRefusal('bad-claims');
    }
    // Whole seconds, as documented: a fractional time is not a time any signer of this contract writes.
    if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp)) {
      throw new DidAuthRefusal('bad-claims');
    }
    // Issued in the future (beyond skew), expiring before or when it was issued, or valid for longer than a proof ever needs to be.
    if (iat > nowSeconds + DID_AUTH_CLOCK_TOLERANCE_SECONDS || exp <= iat || exp - iat > DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS) {
      throw new DidAuthRefusal('bad-claims');
    }
    if (typeof nonce !== 'string' || !constantTimeEqual(nonce, challenge.nonce)) {
      throw new DidAuthRefusal('bad-nonce');
    }

    return { did };
  }

  /** The Hub person a DID is linked to, or null. Never creates one. */
  async findUserId(did: string): Promise<number | null> {
    const link = await this.identities.findByIssuerSubject(DID_KEY_ISSUER, did);

    return link?.userId ?? null;
  }

  /**
   * Link a DID to a person. Idempotent for the same person; a DID bound to someone else is a 409
   * that does not say to whom.
   */
  async link(userId: number, did: string): Promise<'linked' | 'already-linked'> {
    const existing = await this.identities.findByIssuerSubject(DID_KEY_ISSUER, did);
    if (existing) {
      if (existing.userId === userId) {
        return 'already-linked';
      }
      throw new TranslatableError('AUTH_ERROR_DID_ALREADY_LINKED', undefined, HttpStatus.CONFLICT);
    }

    try {
      await this.identities.create({ userId, issuer: DID_KEY_ISSUER, subject: did, email: null, emailVerified: false });
    } catch (error) {
      // Two links of one DID at once: the unique (issuer, subject) index let one through.
      const raced = await this.identities.findByIssuerSubject(DID_KEY_ISSUER, did);
      if (raced?.userId === userId) {
        return 'already-linked';
      }
      if (raced) {
        throw new TranslatableError('AUTH_ERROR_DID_ALREADY_LINKED', undefined, HttpStatus.CONFLICT);
      }
      throw error;
    }

    this.logger.info(`DID sign-in: linked ${shortDid(did)} to user ${userId}`);

    return 'linked';
  }

  /** Remove the caller's own link. A DID linked to anyone else is "not found", not a refusal that says it exists. */
  async unlink(userId: number, did: string): Promise<void> {
    const removed = await this.identities.deleteByUserIssuerSubject(userId, DID_KEY_ISSUER, did);
    if (!removed) {
      throw new TranslatableError('AUTH_ERROR_DID_LINK_NOT_FOUND', undefined, HttpStatus.NOT_FOUND);
    }

    this.logger.info(`DID sign-in: unlinked ${shortDid(did)} from user ${userId}`);
  }

  /** The caller's own DID links. */
  async list(userId: number): Promise<Array<{ did: string; linkedAt: string }>> {
    const rows = await this.identities.findByUserId(userId);

    return rows.filter((row) => row.issuer === DID_KEY_ISSUER).map((row) => ({ did: row.subject, linkedAt: row.createdAt }));
  }
}

/** The tail of a DID, enough to tell two apart in a log without writing a whole identifier. */
function shortDid(did: string): string {
  return `${did.slice(0, 12)}…${did.slice(-6)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}
