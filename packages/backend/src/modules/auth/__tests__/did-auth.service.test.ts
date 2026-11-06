import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import type { CacheService } from '@/core/cache/cache.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { DID_AUTH_FLAG, DidAuthRefusal, type DidAuthPurpose, type DidAuthRefusalReason, DidAuthService } from '../did-auth.service';
import type { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { didKeyFromPublicKey } from '../utils/did-key';

/**
 * The limits below are written as the numbers the documentation states (120 s challenge, 300 s proof,
 * 30 s skew, 4096 characters). They are deliberately NOT imported from the implementation: a test that
 * reads its expectation from the constant it checks moves with it and pins nothing.
 */
const AUDIENCE = 'urn:ci-hub:11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const NOW_S = NOW / 1000;

type Challenge = Awaited<ReturnType<DidAuthService['issueChallenge']>>;

const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A person's identity key, the did:key it spells, and a signer for it. */
function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const did = didKeyFromPublicKey(Buffer.from(x, 'base64url')) as string;

  return { privateKey, publicKey, did };
}

interface TokenOptions {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Sign with this key instead of the identity's own. */
  signWith?: KeyObject;
  /** Replace the encoded signature part with this. */
  rawSignature?: string;
}

const claimsFor = (
  identity: ReturnType<typeof makeIdentity>,
  challenge: { nonce: string; audience: string },
  payload: Record<string, unknown> = {},
) => ({
  iss: identity.did,
  sub: identity.did,
  aud: challenge.audience,
  nonce: challenge.nonce,
  iat: NOW_S,
  exp: NOW_S + 120,
  ...payload,
});

/** A self-issued ID token as a wallet would make it for `challenge`, with any part overridden. */
function makeToken(identity: ReturnType<typeof makeIdentity>, challenge: { nonce: string; audience: string }, options: TokenOptions = {}) {
  const header = { alg: 'EdDSA', typ: 'JWT', ...options.header };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claimsFor(identity, challenge, options.payload)))}`;
  const signature = options.rawSignature ?? sign(null, Buffer.from(signingInput), options.signWith ?? identity.privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

/** The length base64url gives `bytes` bytes, without padding. */
const b64Length = (bytes: number) => 4 * Math.floor(bytes / 3) + ([0, 2, 3][bytes % 3] ?? 0);

/**
 * A validly signed token of EXACTLY `length` characters, made by padding the payload (and, where a
 * length is not reachable with the header as it is, the header). For pinning the 4096-character cap.
 */
function tokenOfLength(identity: ReturnType<typeof makeIdentity>, challenge: { nonce: string; audience: string }, length: number) {
  const signatureLength = 86; // an Ed25519 signature, base64url
  for (let headerPad = 0; headerPad < 8; headerPad += 1) {
    const header = { alg: 'EdDSA', typ: 'JWT', ...(headerPad > 0 ? { h: 'h'.repeat(headerPad) } : {}) };
    const wantedPayloadChars = length - 2 - signatureLength - b64Length(JSON.stringify(header).length);
    // Which payload sizes give exactly that many characters: 3k bytes -> 4k, 3k+1 -> 4k+2, 3k+2 -> 4k+3.
    const residue = wantedPayloadChars % 4;
    if (residue === 1) {
      continue;
    }
    const payloadBytes = Math.floor(wantedPayloadChars / 4) * 3 + { 0: 0, 2: 1, 3: 2 }[residue as 0 | 2 | 3];
    const baseBytes = JSON.stringify({ ...claimsFor(identity, challenge), pad: '' }).length;
    if (payloadBytes < baseBytes) {
      throw new Error('length too small for a token');
    }
    const payload = { ...claimsFor(identity, challenge), pad: 'p'.repeat(payloadBytes - baseBytes) };
    const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const token = `${signingInput}.${sign(null, Buffer.from(signingInput), identity.privateKey).toString('base64url')}`;
    if (token.length === length) {
      return token;
    }
  }
  throw new Error(`no token of ${length} characters`);
}

describe('DidAuthService', () => {
  let cache: MockProxy<CacheService>;
  let identities: MockProxy<FederatedIdentityRepository>;
  let forwardAuth: MockProxy<ForwardAuthIdentityResolver>;
  let logger: MockProxy<LoggerService>;
  let service: DidAuthService;
  let store: Map<string, { value: string; ttl: number | undefined }>;

  beforeEach(() => {
    // The ambient environment is not this test's business: a developer with the feature switched on must get the same result.
    delete process.env[DID_AUTH_FLAG];
    store = new Map();
    cache = mock<CacheService>();
    cache.set.mockImplementation(((key: string, value: string, ttl?: number) => {
      store.set(key, { value, ttl });
    }) as never);
    cache.get.mockImplementation(((key: string) => store.get(key)?.value) as never);
    cache.del.mockImplementation(((key: string) => {
      store.delete(key);
    }) as never);
    identities = mock<FederatedIdentityRepository>();
    forwardAuth = mock<ForwardAuthIdentityResolver>();
    forwardAuth.hubIssuer.mockResolvedValue(AUDIENCE);
    logger = mock<LoggerService>();
    service = new DidAuthService(cache, identities, forwardAuth, logger);
    service.now = () => NOW;
  });

  afterEach(() => {
    delete process.env[DID_AUTH_FLAG];
  });

  describe('the flag', () => {
    it('is off unless the environment says exactly "true"', () => {
      expect(service.enabled).toBe(false);
      for (const value of ['1', 'TRUE', 'True', 'yes', 'on', '', ' true']) {
        process.env[DID_AUTH_FLAG] = value;
        expect(service.enabled).toBe(false);
      }
      process.env[DID_AUTH_FLAG] = 'true';
      expect(service.enabled).toBe(true);
    });

    it('is the variable the documentation tells an operator to set, CI_HUB_DID_AUTH', () => {
      process.env.CI_HUB_DID_AUTH = 'true';

      expect(service.enabled).toBe(true);
      delete process.env.CI_HUB_DID_AUTH;
      expect(service.enabled).toBe(false);
    });

    it('is read per call from the process environment: a change made inside the process is seen at once, which a running Hub never makes', () => {
      process.env[DID_AUTH_FLAG] = 'true';
      expect(service.enabled).toBe(true);
      delete process.env[DID_AUTH_FLAG];
      expect(service.enabled).toBe(false);
    });
  });

  describe('issueChallenge', () => {
    it('names this Hub as the audience and gives a unique nonce of at least 128 bits', async () => {
      const first = await service.issueChallenge();
      const second = await service.issueChallenge();

      expect(first.audience).toBe(AUDIENCE);
      expect(first.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Buffer.from(first.nonce, 'base64url').length).toBeGreaterThanOrEqual(16);
      expect(first.nonce).not.toBe(second.nonce);
      expect(first.challengeId).not.toBe(second.challengeId);
      expect(first.expiresAt).toBe(NOW + 120_000);
    });

    it('is for signing in unless asked for a link, and says which', async () => {
      await expect(service.issueChallenge()).resolves.toMatchObject({ purpose: 'sign-in' });
      await expect(service.issueChallenge('sign-in')).resolves.toMatchObject({ purpose: 'sign-in' });
      await expect(service.issueChallenge('link')).resolves.toMatchObject({ purpose: 'link' });
    });

    it('stores the challenge, with its purpose, for 120 seconds under its own prefix, not for a day', async () => {
      const { challengeId, nonce } = await service.issueChallenge('link');

      const stored = store.get(`did-auth:challenge:${challengeId}`);
      expect(stored?.ttl).toBe(120);
      expect(JSON.parse(stored?.value as string)).toEqual({ nonce, audience: AUDIENCE, purpose: 'link', expiresAt: NOW + 120_000 });
    });

    it('answers 503 with a key, rather than inventing an audience, when the Hub issuer cannot be read', async () => {
      forwardAuth.hubIssuer.mockRejectedValue(new Error('user_directory has no row'));

      const error = await service.issueChallenge().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TranslatableError);
      expect((error as TranslatableError).getResponse()).toMatchObject({ message: 'AUTH_ERROR_DID_UNAVAILABLE' });
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(store.size).toBe(0);
    });
  });

  describe('consumeChallenge', () => {
    it('is single use: the second taking finds nothing', async () => {
      const { challengeId, nonce } = await service.issueChallenge();

      expect(service.consumeChallenge(challengeId)).toEqual({ nonce, audience: AUDIENCE, purpose: 'sign-in' });
      expect(service.consumeChallenge(challengeId)).toBeNull();
      expect(store.size).toBe(0);
    });

    it('refuses an id that is not exactly a UUID, so an id cannot address another key', async () => {
      const uuid = '11111111-2222-4333-8444-555555555555';
      store.set('did-auth:challenge:x', { value: '{}', ttl: 1 });
      store.set(`did-auth:challenge:${uuid}:x`, { value: '{}', ttl: 1 });

      // The last four are a real UUID with something before it, after it, or after a newline: only an anchored pattern refuses them.
      const ids = ['x', '', 'did-auth:challenge:x', '../x', undefined, null, 42, {}, `x${uuid}`, `${uuid}:x`, `${uuid}\n`, `\n${uuid}`];
      for (const id of ids) {
        expect(service.consumeChallenge(id), String(id)).toBeNull();
      }
      expect(cache.get).not.toHaveBeenCalled();
    });

    it('refuses a challenge past its 120 seconds even when the cache has not evicted it yet', async () => {
      const { challengeId } = await service.issueChallenge();
      service.now = () => NOW + 120_000 + 1;

      expect(service.consumeChallenge(challengeId)).toBeNull();
    });

    it('refuses a challenge at the very millisecond it expires', async () => {
      const { challengeId, expiresAt } = await service.issueChallenge();
      service.now = () => expiresAt;

      expect(service.consumeChallenge(challengeId)).toBeNull();
    });

    it('accepts it up to the last moment', async () => {
      const { challengeId } = await service.issueChallenge();
      service.now = () => NOW + 120_000 - 1;

      expect(service.consumeChallenge(challengeId)).not.toBeNull();
    });

    it('refuses an unreadable stored value, one with a field missing, and one with a purpose nobody asked for', () => {
      const good = { nonce: 'n', audience: AUDIENCE, purpose: 'sign-in', expiresAt: NOW + 60_000 };
      const stored: Array<[string, string]> = [
        ['not json', 'not json'],
        ['no audience', JSON.stringify({ ...good, audience: undefined })],
        ['a numeric nonce', JSON.stringify({ ...good, nonce: 1 })],
        ['no purpose (a row from before purposes)', JSON.stringify({ ...good, purpose: undefined })],
        ['an unknown purpose', JSON.stringify({ ...good, purpose: 'unlink' })],
        ['no expiry', JSON.stringify({ ...good, expiresAt: undefined })],
      ];

      stored.forEach(([, value], index) => {
        const id = `11111111-2222-4333-8444-55555555555${index}`;
        store.set(`did-auth:challenge:${id}`, { value, ttl: 1 });

        expect(service.consumeChallenge(id)).toBeNull();
      });
      store.set('did-auth:challenge:11111111-2222-4333-8444-555555555560', { value: JSON.stringify(good), ttl: 1 });
      expect(service.consumeChallenge('11111111-2222-4333-8444-555555555560')).not.toBeNull();
    });
  });

  describe('verify', () => {
    let identity: ReturnType<typeof makeIdentity>;
    let challenge: Challenge;

    beforeEach(async () => {
      identity = makeIdentity();
      challenge = await service.issueChallenge();
    });

    const refused = async (token: unknown, reason: DidAuthRefusalReason, options: { id?: unknown; purpose?: DidAuthPurpose } = {}) => {
      const id = 'id' in options ? options.id : challenge.challengeId;
      await expect(service.verify(id, token, options.purpose ?? 'sign-in')).rejects.toMatchObject({ name: 'DidAuthRefusal', reason });
    };

    it('accepts a proof made for this challenge and returns the DID that signed it', async () => {
      await expect(service.verify(challenge.challengeId, makeToken(identity, challenge), 'sign-in')).resolves.toEqual({ did: identity.did });
    });

    it('reads and writes no binding: a verified proof creates nothing and looks up nobody', async () => {
      await service.verify(challenge.challengeId, makeToken(identity, challenge), 'sign-in');

      expect(identities.create).not.toHaveBeenCalled();
      expect(identities.findByIssuerSubject).not.toHaveBeenCalled();
      expect(identities.findByUserId).not.toHaveBeenCalled();
      expect(identities.deleteByUserIssuerSubject).not.toHaveBeenCalled();
    });

    it('accepts a kid that is the DID or the DID with a fragment, and a token with no kid', async () => {
      for (const kid of [identity.did, `${identity.did}#${identity.did.slice('did:key:'.length)}`, `${identity.did}#`]) {
        const fresh = await service.issueChallenge();
        await expect(service.verify(fresh.challengeId, makeToken(identity, fresh, { header: { kid } }), 'sign-in')).resolves.toEqual({
          did: identity.did,
        });
      }
    });

    it('is single use: a replay of the same proof finds no challenge', async () => {
      const token = makeToken(identity, challenge);

      await expect(service.verify(challenge.challengeId, token, 'sign-in')).resolves.toEqual({ did: identity.did });
      await refused(token, 'unknown-challenge');
    });

    it('spends the challenge on a proof that fails, so a failed guess needs a fresh one', async () => {
      await refused(makeToken(identity, challenge, { header: { alg: 'none' } }), 'bad-alg');
      await refused(makeToken(identity, challenge), 'unknown-challenge');
    });

    it.each([
      ['an empty token', ''],
      ['a number', 42],
      ['an object', {}],
      ['not a JWS at all', 'not.a.jwt'],
      ['an over-long token', 'a'.repeat(5000)],
    ])('spends the challenge on %s as well: the real proof that follows finds nothing', async (_name, bad) => {
      await expect(service.verify(challenge.challengeId, bad, 'sign-in')).rejects.toBeInstanceOf(DidAuthRefusal);

      await refused(makeToken(identity, challenge), 'unknown-challenge');
    });

    // "Spent by whatever proof is presented first, valid or not", for every refusal that is reached after the challenge is read: a
    // proof that is refused for ANY reason, signature, nonce, issuer, key id, audience or time, leaves the genuine one nothing to redeem.
    it.each([
      [
        'a signature by another key',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) => makeToken(id, ch, { signWith: makeIdentity().privateKey }),
      ],
      ['a wrong nonce', (id: ReturnType<typeof makeIdentity>, ch: Challenge) => makeToken(id, ch, { payload: { nonce: 'x'.repeat(32) } })],
      [
        'an issuer that is not a did:key',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) =>
          makeToken(id, ch, { payload: { iss: 'did:web:example.com', sub: 'did:web:example.com' } }),
      ],
      [
        'a kid that names another key',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) => makeToken(id, ch, { header: { kid: makeIdentity().did } }),
      ],
      [
        'another audience',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) =>
          makeToken(id, ch, { payload: { aud: 'urn:ci-hub:99999999-2222-4333-8444-555555555555' } }),
      ],
      [
        'several audiences, one of them this Hub',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) =>
          makeToken(id, ch, { payload: { aud: [ch.audience, 'urn:ci-hub:99999999-2222-4333-8444-555555555555'] } }),
      ],
      [
        'an expired token',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) => makeToken(id, ch, { payload: { iat: NOW_S - 400, exp: NOW_S - 60 } }),
      ],
      [
        'an exp more than 300 s after the iat',
        (id: ReturnType<typeof makeIdentity>, ch: Challenge) => makeToken(id, ch, { payload: { iat: NOW_S, exp: NOW_S + 301 } }),
      ],
    ])('spends the challenge on %s as well: the genuine proof that follows finds nothing', async (_name, build) => {
      await expect(service.verify(challenge.challengeId, build(identity, challenge), 'sign-in')).rejects.toBeInstanceOf(DidAuthRefusal);

      await refused(makeToken(identity, challenge), 'unknown-challenge');
    });

    it('refuses an unknown or malformed challenge id', async () => {
      const token = makeToken(identity, challenge);

      await refused(token, 'unknown-challenge', { id: '11111111-2222-4333-8444-555555555555' });
      await refused(token, 'unknown-challenge', { id: 'not-a-uuid' });
      await refused(token, 'unknown-challenge', { id: null });
      await refused(token, 'unknown-challenge', { id: undefined });
    });

    describe('has one purpose', () => {
      it('refuses a sign-in challenge presented as a link, and spends it', async () => {
        const token = makeToken(identity, challenge);

        await refused(token, 'wrong-purpose', { purpose: 'link' });
        await refused(token, 'unknown-challenge', { purpose: 'sign-in' });
      });

      it('refuses a link challenge presented as a sign-in, and spends it', async () => {
        const linkChallenge = await service.issueChallenge('link');
        const token = makeToken(identity, linkChallenge);

        await refused(token, 'wrong-purpose', { id: linkChallenge.challengeId, purpose: 'sign-in' });
        await refused(token, 'unknown-challenge', { id: linkChallenge.challengeId, purpose: 'link' });
      });

      it('accepts a link challenge as a link', async () => {
        const linkChallenge = await service.issueChallenge('link');

        await expect(service.verify(linkChallenge.challengeId, makeToken(identity, linkChallenge), 'link')).resolves.toEqual({ did: identity.did });
      });
    });

    describe('has a size cap of 4096 characters', () => {
      it('accepts a validly signed token of exactly 4096 characters', async () => {
        const token = tokenOfLength(identity, challenge, 4096);

        expect(token).toHaveLength(4096);
        await expect(service.verify(challenge.challengeId, token, 'sign-in')).resolves.toEqual({ did: identity.did });
      });

      it('refuses a validly signed token of 4097 characters, and of 4098', async () => {
        for (const length of [4097, 4098]) {
          const fresh = await service.issueChallenge();
          const token = tokenOfLength(identity, fresh, length);

          expect(token).toHaveLength(length);
          await refused(token, 'malformed', { id: fresh.challengeId });
        }
      });
    });

    describe('refuses a token that is not a well-formed EdDSA JWS', () => {
      it.each([
        ['an empty token', ''],
        ['a non-string', 42],
        ['garbage', 'not.a.jwt'],
        ['two parts', 'aaaa.bbbb'],
        ['an over-long token', `${'a'.repeat(5000)}.b.c`],
      ])('%s', async (_name, token) => {
        await refused(token, 'malformed');
      });

      it.each([
        ['alg none', { alg: 'none' }],
        ['HS256', { alg: 'HS256' }],
        ['RS256', { alg: 'RS256' }],
        ['ES256', { alg: 'ES256' }],
        ['a missing alg', { alg: undefined }],
      ])('%s', async (_name, header) => {
        await refused(makeToken(identity, challenge, { header }), 'bad-alg');
      });

      it('an unsigned alg-none token with an empty signature', async () => {
        await refused(makeToken(identity, challenge, { header: { alg: 'none' }, rawSignature: '' }), 'bad-alg');
      });

      it('an HS256 token with a real HMAC under the public key bytes, refused on its alg before any signature is read', async () => {
        const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
        const payload = b64u(JSON.stringify(claimsFor(identity, challenge)));
        const publicKeyBytes = Buffer.from((identity.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
        const mac = createHmac('sha256', publicKeyBytes).update(`${header}.${payload}`).digest('base64url');

        await refused(`${header}.${payload}.${mac}`, 'bad-alg');
      });
    });

    describe('refuses a token whose issuer is not an Ed25519 did:key', () => {
      it.each([
        ['an X25519 did:key', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
        ['a secp256k1 did:key', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
        ['a P-256 did:key', 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
        ['a did:web', 'did:web:example.com'],
        ['a did:webvh', 'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example'],
        ['a did:keri AID', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
        ['a DID URL', 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw#z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw'],
        ['a URL', 'https://alice.example/'],
        ['an email', 'alice@example.com'],
        // The identity point's did:key: well formed, and a signature "verifies" under it with no private key.
        ['the identity point (a small-order key)', `did:key:z${'6MkeXATEjyXENzBXBxgC5EHk2JE5aqd7qMGGtDpLUH1e2Sj'}`],
        ['the all-zero key (a small-order key)', 'did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP'],
      ])('%s', async (_name, iss) => {
        await refused(makeToken(identity, challenge, { payload: { iss, sub: iss } }), 'bad-did');
      });

      it('a missing iss', async () => {
        await refused(makeToken(identity, challenge, { payload: { iss: undefined } }), 'bad-did');
      });
    });

    it('refuses a forged proof for a small-order key, which a naive verifier would accept with no private key', async () => {
      // A signature (R = identity point, S = 0) verifies for ANY message under the identity key. The
      // codec refuses the DID, so the service never reaches a verifier that would say yes.
      const identityKeyDid = 'did:key:z6MkeXATEjyXENzBXBxgC5EHk2JE5aqd7qMGGtDpLUH1e2Sj';
      const forged = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64u(
        JSON.stringify({ iss: identityKeyDid, sub: identityKeyDid, aud: AUDIENCE, nonce: challenge.nonce, iat: NOW_S, exp: NOW_S + 60 }),
      )}.${b64u(Buffer.concat([Buffer.from('01', 'hex'), Buffer.alloc(63)]))}`;

      await refused(forged, 'bad-did');
    });

    it('refuses iss that differs from sub, even when both are real did:keys', async () => {
      const other = makeIdentity();

      await refused(makeToken(identity, challenge, { payload: { sub: other.did } }), 'bad-claims');
    });

    it('refuses a signature by a different key than the DID, however the claims read', async () => {
      const attacker = makeIdentity();

      // The attacker names the victim's DID and signs with their own key.
      await refused(makeToken(identity, challenge, { signWith: attacker.privateKey }), 'bad-signature');
    });

    it('refuses a tampered payload and a tampered signature', async () => {
      const token = makeToken(identity, challenge);
      const [header, payload, signature] = token.split('.') as [string, string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      const swapped = b64u(JSON.stringify({ ...claims, exp: NOW_S + 290 }));

      await refused(`${header}.${swapped}.${signature}`, 'bad-signature');

      const second = await service.issueChallenge();
      const resigned = makeToken(identity, second);
      const [h, p, s] = resigned.split('.') as [string, string, string];
      const flipped = `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
      await refused(`${h}.${p}.${flipped}`, 'bad-signature', { id: second.challengeId });
    });

    describe('refuses a kid that names another key, and never selects a key by header', () => {
      it.each([
        ['another did:key', () => makeIdentity().did],
        ['another did:key with a fragment', () => `${makeIdentity().did}#key-1`],
        ['a bare fragment', () => '#key-1'],
        ['a URL', () => 'https://attacker.example/key'],
        ['a non-string', () => 42],
        ['null, which is not the same as no kid', () => null],
      ])('%s', async (_name, kid) => {
        await refused(makeToken(identity, challenge, { header: { kid: kid() } }), 'bad-kid');
      });

      it('a kid that merely STARTS with the DID, with no # after it', async () => {
        await refused(makeToken(identity, challenge, { header: { kid: `${identity.did}x` } }), 'bad-kid');
      });

      it('ignores a jwk, jku or x5u header: the key is the DID, whatever the token carries', async () => {
        const attacker = makeIdentity();
        const attackerJwk = attacker.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

        // Signed by the attacker, carrying the attacker's key in the header, naming the victim's DID.
        const token = makeToken(identity, challenge, {
          header: { jwk: attackerJwk, jku: 'https://attacker.example/jwks', x5u: 'https://attacker.example/cert' },
          signWith: attacker.privateKey,
        });

        await refused(token, 'bad-signature');
      });
    });

    describe('refuses claims that do not fit this challenge', () => {
      it.each([
        ['another audience', { aud: 'urn:ci-hub:99999999-2222-4333-8444-555555555555' }, 'bad-claims'],
        ['Portal as the audience', { aud: 'https://hub.ci.computer' }, 'bad-claims'],
        ['no audience', { aud: undefined }, 'bad-claims'],
        ['several audiences', { aud: [AUDIENCE, 'urn:ci-hub:99999999-2222-4333-8444-555555555555'] }, 'bad-claims'],
        ['the audience in an array', { aud: [AUDIENCE] }, 'bad-claims'],
        ['another nonce', { nonce: 'a-different-nonce-entirely-00000' }, 'bad-nonce'],
        ['no nonce', { nonce: undefined }, 'bad-claims'],
        ['a non-string nonce', { nonce: 12345 }, 'bad-nonce'],
        ['an expired token', { iat: NOW_S - 400, exp: NOW_S - 60 }, 'bad-claims'],
        ['no exp', { exp: undefined }, 'bad-claims'],
        ['no iat', { iat: undefined }, 'bad-claims'],
        ['a string exp', { exp: String(NOW_S + 60) }, 'bad-claims'],
        ['a fractional iat', { iat: NOW_S + 0.5, exp: NOW_S + 60 }, 'bad-claims'],
        ['a fractional exp', { iat: NOW_S, exp: NOW_S + 60.5 }, 'bad-claims'],
        ['an exp equal to the iat', { iat: NOW_S, exp: NOW_S }, 'bad-claims'],
        ['an exp before the iat, still ahead of now', { iat: NOW_S + 30, exp: NOW_S + 5 }, 'bad-claims'],
        ['an exp before the iat, just inside the clock tolerance', { iat: NOW_S, exp: NOW_S - 5 }, 'bad-claims'],
        ['an iat in the future beyond skew', { iat: NOW_S + 3600, exp: NOW_S + 3660 }, 'bad-claims'],
        ['a not-yet-valid token', { nbf: NOW_S + 3600 }, 'bad-claims'],
      ])('%s', async (_name, payload, reason) => {
        await refused(makeToken(identity, challenge, { payload }), reason as DidAuthRefusalReason);
      });

      it('a nonce that is the real one with something appended or removed', async () => {
        await refused(makeToken(identity, challenge, { payload: { nonce: `${challenge.nonce}x` } }), 'bad-nonce');

        const second = await service.issueChallenge();
        await refused(makeToken(identity, second, { payload: { nonce: second.nonce.slice(0, -1) } }), 'bad-nonce', { id: second.challengeId });
      });
    });

    describe('has the limits the documentation states', () => {
      const accepts = async (payload: Record<string, unknown>) => {
        const fresh = await service.issueChallenge();
        await expect(service.verify(fresh.challengeId, makeToken(identity, fresh, { payload }), 'sign-in')).resolves.toEqual({ did: identity.did });
      };
      const refusesClaims = async (payload: Record<string, unknown>) => {
        const fresh = await service.issueChallenge();
        await refused(makeToken(identity, fresh, { payload }), 'bad-claims', { id: fresh.challengeId });
      };

      it('lets a proof live 300 seconds and not 301', async () => {
        await accepts({ iat: NOW_S, exp: NOW_S + 300 });
        await refusesClaims({ iat: NOW_S, exp: NOW_S + 301 });
      });

      it('lets a signer’s clock run 30 seconds ahead and not 31', async () => {
        await accepts({ iat: NOW_S + 30, exp: NOW_S + 100 });
        await refusesClaims({ iat: NOW_S + 31, exp: NOW_S + 100 });
      });

      it('reads its own clock in whole seconds, rounded down: at x.6 s an iat 31 s ahead is still too far ahead', async () => {
        service.now = () => NOW + 600;

        await accepts({ iat: NOW_S + 30, exp: NOW_S + 100 });
        await refusesClaims({ iat: NOW_S + 31, exp: NOW_S + 100 });
      });

      it('lets a proof that expired 29 seconds ago pass and not one that expired 30 seconds ago', async () => {
        await accepts({ iat: NOW_S - 100, exp: NOW_S - 29 });
        await refusesClaims({ iat: NOW_S - 100, exp: NOW_S - 30 });
      });

      it('lets a proof live one second', async () => {
        await accepts({ iat: NOW_S, exp: NOW_S + 1 });
      });
    });

    it('throws a DidAuthRefusal, never a bare error, for every refusal', async () => {
      await expect(service.verify(challenge.challengeId, 'garbage', 'sign-in')).rejects.toBeInstanceOf(DidAuthRefusal);
    });
  });

  describe('links', () => {
    const did = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

    it('finds the person a DID is linked to, under the did:key issuer, and nobody otherwise', async () => {
      identities.findByIssuerSubject.mockResolvedValueOnce({ id: 1, userId: 7, issuer: 'did:key', subject: did } as never);
      await expect(service.findUserId(did)).resolves.toBe(7);
      expect(identities.findByIssuerSubject).toHaveBeenCalledWith('did:key', did);

      identities.findByIssuerSubject.mockResolvedValueOnce(undefined as never);
      await expect(service.findUserId(did)).resolves.toBeNull();
    });

    it('links a new DID with no email and nothing verified, and says so', async () => {
      identities.findByIssuerSubject.mockResolvedValue(undefined as never);

      await expect(service.link(7, did)).resolves.toBe('linked');
      expect(identities.create).toHaveBeenCalledWith({ userId: 7, issuer: 'did:key', subject: did, email: null, emailVerified: false });
    });

    it('is idempotent for the same person', async () => {
      identities.findByIssuerSubject.mockResolvedValue({ id: 1, userId: 7, issuer: 'did:key', subject: did } as never);

      await expect(service.link(7, did)).resolves.toBe('already-linked');
      expect(identities.create).not.toHaveBeenCalled();
    });

    const conflictOf = async (promise: Promise<unknown>) => {
      const error = await promise.catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TranslatableError);
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error as TranslatableError).getResponse()).toMatchObject({ message: 'AUTH_ERROR_DID_ALREADY_LINKED' });
      return error as TranslatableError;
    };

    it('refuses a DID bound to someone else with a 409 that does not say whom', async () => {
      identities.findByIssuerSubject.mockResolvedValue({ id: 1, userId: 8, issuer: 'did:key', subject: did } as never);

      const error = await conflictOf(service.link(7, did));

      expect(JSON.stringify(error.getResponse())).not.toMatch(/\b8\b/);
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('resolves a race with the unique index by reading the winner', async () => {
      identities.findByIssuerSubject.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce({ id: 2, userId: 8 } as never);
      identities.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await conflictOf(service.link(7, did));

      identities.findByIssuerSubject.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce({ id: 2, userId: 7 } as never);
      identities.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await expect(service.link(7, did)).resolves.toBe('already-linked');
    });

    it('rethrows an insert failure that is not a race', async () => {
      identities.findByIssuerSubject.mockResolvedValue(undefined as never);
      identities.create.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.link(7, did)).rejects.toThrow('connection refused');
    });

    it('unlinks only the caller’s own binding, and a miss is a 404 whoever else holds the DID', async () => {
      identities.deleteByUserIssuerSubject.mockResolvedValueOnce(true);
      await expect(service.unlink(7, did)).resolves.toBeUndefined();
      expect(identities.deleteByUserIssuerSubject).toHaveBeenCalledWith(7, 'did:key', did);

      identities.deleteByUserIssuerSubject.mockResolvedValueOnce(false);
      const error = await service.unlink(7, did).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TranslatableError);
      expect((error as TranslatableError).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect((error as TranslatableError).getResponse()).toMatchObject({ message: 'AUTH_ERROR_DID_LINK_NOT_FOUND' });
    });

    it('lists the caller’s DID links and leaves Portal links out', async () => {
      identities.findByUserId.mockResolvedValue([
        { id: 1, userId: 7, issuer: 'https://hub.example.com', subject: 'portal-sub', createdAt: '2026-01-01' },
        { id: 2, userId: 7, issuer: 'did:key', subject: did, createdAt: '2026-11-05 12:00:00' },
      ] as never);

      await expect(service.list(7)).resolves.toEqual([{ did, linkedAt: '2026-11-05 12:00:00' }]);
      expect(identities.findByUserId).toHaveBeenCalledWith(7);
    });
  });
});
