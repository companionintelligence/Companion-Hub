import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CacheService } from '@/core/cache/cache.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { ForwardAuthIdentityResolver } from './forward-auth-identity.resolver';
import { didKeyPublicKey, isDidKey } from './utils/did-key';

/**
 * Sign in with a DID: the Hub half of ADR-0016 (Local.Pub alongside KERI).
 *
 * ═══ WHAT IT IS ═══
 *
 * A person whose identity key is a canonical Ed25519 `did:key` (Local.Pub publishes exactly such
 * keys for its owners) proves control of it by signing a challenge this Hub issued. The proof is a
 * SIOPv2-shaped self-issued ID token, a compact JWS signed with EdDSA:
 *
 *   header   {"alg":"EdDSA","typ":"JWT","kid":"<did>" or "<did>#<fragment>"}     (kid optional)
 *   payload  {"iss":"<did>","sub":"<did>","aud":"<audience>","nonce":"<nonce>","iat":n,"exp":n}
 *
 * `audience` and `nonce` come from {@link DidAuthService.issueChallenge}; `iat`/`exp` are Unix
 * seconds and `exp - iat` may not exceed {@link DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS}.
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

const CHALLENGE_PREFIX = 'did-auth:challenge:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN_CHARS = 4096;

export interface DidAuthChallenge {
  challengeId: string;
  nonce: string;
  audience: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

export type DidAuthRefusalReason =
  | 'unknown-challenge'
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
   * A single-use challenge. The audience is this Hub's own issuer (`urn:ci-hub:<directory id>`), the
   * name forward auth already signs people under, so a proof made for another Hub, or for Portal,
   * names a different audience and does not verify here.
   */
  async issueChallenge(): Promise<DidAuthChallenge> {
    let audience: string;
    try {
      audience = await this.forwardAuth.hubIssuer();
    } catch (error) {
      this.logger.warn(`DID sign-in could not read this Hub's issuer: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('DID sign-in is temporarily unavailable');
    }

    const challengeId = randomUUID();
    // 192 bits. Not a secret from the person who asked, but unguessable by anyone who did not.
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + DID_AUTH_CHALLENGE_TTL_SECONDS * 1000;

    this.cache.set(`${CHALLENGE_PREFIX}${challengeId}`, JSON.stringify({ nonce, audience, expiresAt }), DID_AUTH_CHALLENGE_TTL_SECONDS);

    return { challengeId, nonce, audience, expiresAt };
  }

  /**
   * Take a challenge out of the store: read, then delete, in one synchronous step. A challenge can be
   * answered once, even by a proof that then fails, so a captured proof cannot be tried again and a
   * guess at a signature costs a fresh challenge each time.
   */
  consumeChallenge(challengeId: unknown): { nonce: string; audience: string } | null {
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
      const parsed = JSON.parse(raw) as { nonce?: unknown; audience?: unknown; expiresAt?: unknown };
      if (typeof parsed.nonce !== 'string' || typeof parsed.audience !== 'string' || typeof parsed.expiresAt !== 'number') {
        return null;
      }
      // The cache expires it too; this is the check that does not depend on the cache's clock.
      return parsed.expiresAt > this.now() ? { nonce: parsed.nonce, audience: parsed.audience } : null;
    } catch {
      return null;
    }
  }

  /**
   * Check a proof against the challenge it answers and return the DID that signed it.
   *
   * Every refusal is a {@link DidAuthRefusal}. The challenge is spent first, so no refusal leaves it
   * available to try again.
   */
  async verify(challengeId: unknown, idToken: unknown): Promise<{ did: string }> {
    const challenge = this.consumeChallenge(challengeId);
    if (!challenge) {
      throw new DidAuthRefusal('unknown-challenge');
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
    if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)) {
      throw new DidAuthRefusal('bad-claims');
    }
    // Issued in the future (beyond skew), or valid for longer than a proof ever needs to be.
    if (iat > nowSeconds + DID_AUTH_CLOCK_TOLERANCE_SECONDS || exp - iat > DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS) {
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
      throw new ConflictException({ code: 'DID_ALREADY_LINKED', message: 'That DID is already linked to a Hub person' });
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
        throw new ConflictException({ code: 'DID_ALREADY_LINKED', message: 'That DID is already linked to a Hub person' });
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
      throw new NotFoundException({ code: 'DID_NOT_LINKED', message: 'That DID is not linked to your account' });
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
