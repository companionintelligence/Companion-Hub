import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { CacheService } from '@/core/cache/cache.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import {
  DID_AUTH_CHALLENGE_TTL_SECONDS,
  DID_AUTH_FLAG,
  DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS,
  DID_KEY_ISSUER,
  DidAuthRefusal,
  type DidAuthRefusalReason,
  DidAuthService,
} from '../did-auth.service';
import type { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { didKeyFromPublicKey } from '../utils/did-key';

const AUDIENCE = 'urn:ci-hub:11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const NOW_S = NOW / 1000;

const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A person's identity key, the did:key it spells, and a signer for it. */
function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const did = didKeyFromPublicKey(Buffer.from(x, 'base64url')) as string;

  return { privateKey, did };
}

interface TokenOptions {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Sign with this key instead of the identity's own. */
  signWith?: KeyObject;
  /** Replace the encoded signature part with this. */
  rawSignature?: string;
}

/** A self-issued ID token as a wallet would make it for `challenge`, with any part overridden. */
function makeToken(identity: ReturnType<typeof makeIdentity>, challenge: { nonce: string; audience: string }, options: TokenOptions = {}) {
  const header = { alg: 'EdDSA', typ: 'JWT', ...options.header };
  const payload = {
    iss: identity.did,
    sub: identity.did,
    aud: challenge.audience,
    nonce: challenge.nonce,
    iat: NOW_S,
    exp: NOW_S + 120,
    ...options.payload,
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = options.rawSignature ?? sign(null, Buffer.from(signingInput), options.signWith ?? identity.privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

describe('DidAuthService', () => {
  let cache: MockProxy<CacheService>;
  let identities: MockProxy<FederatedIdentityRepository>;
  let forwardAuth: MockProxy<ForwardAuthIdentityResolver>;
  let logger: MockProxy<LoggerService>;
  let service: DidAuthService;
  let store: Map<string, { value: string; ttl: number | undefined }>;

  beforeEach(() => {
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

    it('is read per call, so it follows the environment', () => {
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
      expect(first.expiresAt).toBe(NOW + DID_AUTH_CHALLENGE_TTL_SECONDS * 1000);
    });

    it('stores the challenge for two minutes under its own prefix, not for a day', async () => {
      const { challengeId } = await service.issueChallenge();

      expect(store.get(`did-auth:challenge:${challengeId}`)?.ttl).toBe(120);
    });

    it('answers 503 rather than inventing an audience when the Hub issuer cannot be read', async () => {
      forwardAuth.hubIssuer.mockRejectedValue(new Error('user_directory has no row'));

      await expect(service.issueChallenge()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(store.size).toBe(0);
    });
  });

  describe('consumeChallenge', () => {
    it('is single use: the second taking finds nothing', async () => {
      const { challengeId, nonce } = await service.issueChallenge();

      expect(service.consumeChallenge(challengeId)).toEqual({ nonce, audience: AUDIENCE });
      expect(service.consumeChallenge(challengeId)).toBeNull();
      expect(store.size).toBe(0);
    });

    it('refuses an id that is not a UUID, so an id cannot address another key', async () => {
      store.set('did-auth:challenge:x', { value: '{}', ttl: 1 });

      for (const id of ['x', '', 'did-auth:challenge:x', '../x', undefined, null, 42, {}]) {
        expect(service.consumeChallenge(id)).toBeNull();
      }
      expect(cache.get).not.toHaveBeenCalled();
    });

    it('refuses a challenge past its time even when the cache has not evicted it yet', async () => {
      const { challengeId } = await service.issueChallenge();
      service.now = () => NOW + DID_AUTH_CHALLENGE_TTL_SECONDS * 1000 + 1;

      expect(service.consumeChallenge(challengeId)).toBeNull();
    });

    it('refuses an unreadable stored value', () => {
      const id = '11111111-2222-4333-8444-555555555555';
      store.set(`did-auth:challenge:${id}`, { value: 'not json', ttl: 1 });
      expect(service.consumeChallenge(id)).toBeNull();

      const other = '11111111-2222-4333-8444-555555555556';
      store.set(`did-auth:challenge:${other}`, { value: JSON.stringify({ nonce: 1 }), ttl: 1 });
      expect(service.consumeChallenge(other)).toBeNull();
    });
  });

  describe('verify', () => {
    let identity: ReturnType<typeof makeIdentity>;
    let challenge: Awaited<ReturnType<DidAuthService['issueChallenge']>>;

    beforeEach(async () => {
      identity = makeIdentity();
      challenge = await service.issueChallenge();
    });

    const refused = async (token: unknown, reason: DidAuthRefusalReason, challengeId: unknown = challenge.challengeId) => {
      await expect(service.verify(challengeId, token)).rejects.toMatchObject({ name: 'DidAuthRefusal', reason });
    };

    it('accepts a proof made for this challenge and returns the DID that signed it', async () => {
      await expect(service.verify(challenge.challengeId, makeToken(identity, challenge))).resolves.toEqual({ did: identity.did });
    });

    it('accepts a kid that is the DID, or the DID with a fragment, and a token with no kid', async () => {
      for (const kid of [identity.did, `${identity.did}#${identity.did.slice('did:key:'.length)}`]) {
        const fresh = await service.issueChallenge();
        await expect(service.verify(fresh.challengeId, makeToken(identity, fresh, { header: { kid } }))).resolves.toEqual({ did: identity.did });
      }
    });

    it('is single use: a replay of the same proof finds no challenge', async () => {
      const token = makeToken(identity, challenge);

      await expect(service.verify(challenge.challengeId, token)).resolves.toEqual({ did: identity.did });
      await refused(token, 'unknown-challenge');
    });

    it('spends the challenge even when the proof fails, so a failed guess needs a fresh one', async () => {
      await refused(makeToken(identity, challenge, { header: { alg: 'none' } }), 'bad-alg');
      await refused(makeToken(identity, challenge), 'unknown-challenge');
    });

    it('refuses an unknown or malformed challenge id', async () => {
      const token = makeToken(identity, challenge);

      await refused(token, 'unknown-challenge', '11111111-2222-4333-8444-555555555555');
      await refused(token, 'unknown-challenge', 'not-a-uuid');
      // null, not undefined: an undefined argument would pick up the helper's default, the real challenge.
      await refused(token, 'unknown-challenge', null);
    });

    it('refuses a challenge that was never issued by this Hub for this audience', async () => {
      const foreign = { nonce: challenge.nonce, audience: 'urn:ci-hub:99999999-2222-4333-8444-555555555555' };

      await refused(makeToken(identity, foreign), 'bad-claims');
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

      it('an HS256 token MACed with the public key bytes as the secret (algorithm confusion)', async () => {
        const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
        const payload = b64u(
          JSON.stringify({ iss: identity.did, sub: identity.did, aud: challenge.audience, nonce: challenge.nonce, iat: NOW_S, exp: NOW_S + 60 }),
        );
        const mac = createHash('sha256').update(`${header}.${payload}.${identity.did}`).digest('base64url');

        await refused(`${header}.${payload}.${mac}`, 'bad-alg');
      });
    });

    describe('refuses a token whose issuer is not a canonical Ed25519 did:key', () => {
      it.each([
        ['an X25519 did:key', 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc'],
        ['a secp256k1 did:key', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'],
        ['a P-256 did:key', 'did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169'],
        ['a did:web', 'did:web:local.pub'],
        ['a did:webvh', 'did:webvh:QmSyntheticSyntheticSyntheticSyntheticSynth:alice.example'],
        ['a did:keri AID', 'did:keri:D6Zwb8HfPqmyZXwMt1k0fKQPwoSTmN2GqmXdB2eyd1Mq'],
        ['a DID URL', 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw#z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw'],
        ['a URL', 'https://alice.example/'],
        ['an email', 'alice@example.com'],
      ])('%s', async (_name, iss) => {
        await refused(makeToken(identity, challenge, { payload: { iss, sub: iss } }), 'bad-did');
      });

      it('a missing iss', async () => {
        await refused(makeToken(identity, challenge, { payload: { iss: undefined } }), 'bad-did');
      });
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
      const [header, payload, signature] = token.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      const swapped = b64u(JSON.stringify({ ...claims, exp: NOW_S + 290 }));

      await refused(`${header}.${swapped}.${signature}`, 'bad-signature');

      const second = await service.issueChallenge();
      const resigned = makeToken(identity, second);
      const [h, p, s] = resigned.split('.');
      const flipped = `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
      await refused(`${h}.${p}.${flipped}`, 'bad-signature', second.challengeId);
    });

    describe('refuses a kid that names another key, and never selects a key by header', () => {
      it.each([
        ['another did:key', () => makeIdentity().did],
        ['another did:key with a fragment', () => `${makeIdentity().did}#key-1`],
        ['a bare fragment', () => '#key-1'],
        ['a URL', () => 'https://attacker.example/key'],
        ['a non-string', () => 42],
      ])('%s', async (_name, kid) => {
        await refused(makeToken(identity, challenge, { header: { kid: kid() } }), 'bad-kid');
      });

      it('ignores a jwk, jku or x5u header: the key is the DID, whatever the token carries', async () => {
        const attacker = makeIdentity();
        const attackerJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

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
        ['an iat in the future beyond skew', { iat: NOW_S + 3600, exp: NOW_S + 3660 }, 'bad-claims'],
        ['a validity longer than a proof needs', { iat: NOW_S, exp: NOW_S + DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS + 1 }, 'bad-claims'],
        ['a not-yet-valid token', { nbf: NOW_S + 3600 }, 'bad-claims'],
      ])('%s', async (_name, payload, reason) => {
        await refused(makeToken(identity, challenge, { payload }), reason as DidAuthRefusalReason);
      });

      it('a nonce that is the real one with something appended or removed', async () => {
        await refused(makeToken(identity, challenge, { payload: { nonce: `${challenge.nonce}x` } }), 'bad-nonce');

        const second = await service.issueChallenge();
        await refused(makeToken(identity, second, { payload: { nonce: second.nonce.slice(0, -1) } }), 'bad-nonce', second.challengeId);
      });
    });

    it('accepts the edges: a signer 20 seconds ahead, and the longest allowed validity', async () => {
      await expect(
        service.verify(challenge.challengeId, makeToken(identity, challenge, { payload: { iat: NOW_S + 20, exp: NOW_S + 140 } })),
      ).resolves.toEqual({ did: identity.did });

      const second = await service.issueChallenge();
      await expect(
        service.verify(
          second.challengeId,
          makeToken(identity, second, { payload: { iat: NOW_S, exp: NOW_S + DID_AUTH_MAX_TOKEN_LIFETIME_SECONDS } }),
        ),
      ).resolves.toEqual({ did: identity.did });
    });

    it('accepts a token that expired a few seconds ago, within the clock tolerance, and not one that expired a minute ago', async () => {
      await expect(
        service.verify(challenge.challengeId, makeToken(identity, challenge, { payload: { iat: NOW_S - 100, exp: NOW_S - 10 } })),
      ).resolves.toEqual({ did: identity.did });

      const second = await service.issueChallenge();
      await refused(makeToken(identity, second, { payload: { iat: NOW_S - 200, exp: NOW_S - 60 } }), 'bad-claims', second.challengeId);
    });

    it('throws a DidAuthRefusal, never a bare error, for every refusal', async () => {
      await expect(service.verify(challenge.challengeId, 'garbage')).rejects.toBeInstanceOf(DidAuthRefusal);
    });
  });

  describe('links', () => {
    const did = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

    it('finds the person a DID is linked to, under the did:key issuer, and nobody otherwise', async () => {
      identities.findByIssuerSubject.mockResolvedValueOnce({ id: 1, userId: 7, issuer: DID_KEY_ISSUER, subject: did } as never);
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

    it('refuses a DID bound to someone else with a 409 that does not say whom', async () => {
      identities.findByIssuerSubject.mockResolvedValue({ id: 1, userId: 8, issuer: 'did:key', subject: did } as never);

      const error = await service.link(7, did).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(JSON.stringify((error as ConflictException).getResponse())).not.toMatch(/\b8\b/);
      expect(identities.create).not.toHaveBeenCalled();
    });

    it('resolves a race with the unique index by reading the winner', async () => {
      identities.findByIssuerSubject.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce({ id: 2, userId: 8 } as never);
      identities.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await expect(service.link(7, did)).rejects.toBeInstanceOf(ConflictException);

      identities.findByIssuerSubject.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce({ id: 2, userId: 7 } as never);
      identities.create.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await expect(service.link(7, did)).resolves.toBe('already-linked');
    });

    it('rethrows an insert failure that is not a race', async () => {
      identities.findByIssuerSubject.mockResolvedValue(undefined as never);
      identities.create.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.link(7, did)).rejects.toThrow('connection refused');
    });

    it('unlinks only the caller’s own binding, and a miss is "not found" whoever else holds the DID', async () => {
      identities.deleteByUserIssuerSubject.mockResolvedValueOnce(true);
      await expect(service.unlink(7, did)).resolves.toBeUndefined();
      expect(identities.deleteByUserIssuerSubject).toHaveBeenCalledWith(7, 'did:key', did);

      identities.deleteByUserIssuerSubject.mockResolvedValueOnce(false);
      await expect(service.unlink(7, did)).rejects.toBeInstanceOf(NotFoundException);
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
