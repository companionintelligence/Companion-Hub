/**
 * Sign in with a DID through the whole HTTP stack: a real Nest app on a real port with the parts of the
 * bootstrap of `main.ts` that decide these answers (global prefix `/api`, CORS, cookie parser, the
 * default body parsers, `payloadTooLargeHandler`, `trust proxy`), the real
 * `AuthMiddleware`, `ZodValidationPipe` and `MainExceptionFilter`, the real `AuthController` with its real
 * guards, and the real `DidAuthService`, `AuthService`, `SessionManager`, `SessionUserCache` and
 * `AuthRateLimiter`. Only what sits behind them is faked: the databases (users, federated identities),
 * the cache, Portal, and the key store.
 *
 * Calling the controller's methods (`did-auth.controller.test.ts`) cannot show that the router reaches a
 * route, that the global pipe reads its body, that the guards run in the order the decorators say, or what
 * a browser is told. This file does, with `node:http` rather than `fetch` so a test can set `Host` and
 * `Origin` exactly as a browser's request would carry them.
 *
 * Not supertest: it is not installed, and the repo's own real-HTTP blocks (`auth.controller.test.ts`) use
 * `createNestApplication()` and a listening port, which is all this needs.
 *
 * What it does NOT boot, so what it cannot see: `ServeStaticModule`, whose SPA fallback an image with the
 * frontend bundle adds (it answers an absolute-form `GET` or `HEAD` for `/api/…` with `index.html` on a build
 * without the DID routes, where the flag-off Hub answers 404: a known residual, see `did-auth.guard.ts`);
 * the large-body parsers for the inference and MCP paths; the root bounce route; and the Swagger document
 * that `main.ts` serves outside production. The twin comparison below is therefore a comparison of the
 * routing and error answers of the two apps, not of the production image.
 */
import 'reflect-metadata';
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { MainExceptionFilter } from '@/common/error/exception.filter';
import { DEFAULT_BODY_LIMIT, payloadTooLargeHandler } from '@/common/helpers/body-limits';
import { resolveAllowedCorsOrigin } from '@/common/helpers/cors-origin';
import { ZodValidationPipe } from '@/common/zod-dto';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { PasswordService } from '@/core/password/password.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { AuthController } from '../auth.controller';
import { AuthMiddleware } from '../auth.middleware';
import { AuthRateLimiter } from '../auth-rate-limiter';
import { ProxyTrustService } from '@/modules/network/proxy-trust.service';
import { AuthService } from '../auth.service';
import { BearerOrgMembershipCache } from '../bearer-org-membership.cache';
import { DID_AUTH_FLAG, DidAuthService } from '../did-auth.service';
import { ForwardAuthIdentityResolver } from '../forward-auth-identity.resolver';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';
import { MemoryApiKeyCheck } from '../memory-api-key.check';
import { SessionManager } from '../session.manager';
import { didKeyFromPublicKey } from '../utils/did-key';

// ── what sits behind the app ─────────────────────────────────────────────────────────────────────

/** The cache surface `SessionManager` and `DidAuthService` use, with real expiry. */
class FakeCache {
  entries = new Map<string, { value: string; expiresAt: number }>();

  set(key: string, value: string, ttlSeconds = 86_400) {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  getExpirationAt(key: string) {
    const entry = this.entries.get(key);

    return entry && entry.expiresAt >= Date.now() ? entry.expiresAt : null;
  }

  del(key: string) {
    this.entries.delete(key);
  }

  getByPrefix(prefix: string) {
    return [...this.entries.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, entry]) => ({ key, val: entry.value }));
  }
}

interface FederatedRow {
  id: number;
  userId: number;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: string;
}

/** `federated_identity`, with the unique index on (issuer, subject) the real table has. */
class FakeFederatedIdentities {
  rows: FederatedRow[] = [];

  findByIssuerSubject = async (issuer: string, subject: string) => this.rows.find((row) => row.issuer === issuer && row.subject === subject);

  findByUserId = async (userId: number) => this.rows.filter((row) => row.userId === userId);

  create = async (data: { userId: number; issuer: string; subject: string; email: string | null; emailVerified: boolean }) => {
    if (this.rows.some((row) => row.issuer === data.issuer && row.subject === data.subject)) {
      throw new Error('duplicate key value violates unique constraint');
    }
    const row = { id: this.rows.length + 1, createdAt: '2026-11-05 12:00:00', ...data };
    this.rows.push(row);

    return row;
  };

  deleteByUserIssuerSubject = async (userId: number, issuer: string, subject: string) => {
    const index = this.rows.findIndex((row) => row.userId === userId && row.issuer === issuer && row.subject === subject);
    if (index < 0) {
      return false;
    }
    this.rows.splice(index, 1);

    return true;
  };
}

const AUDIENCE = 'urn:ci-hub:11111111-2222-4333-8444-555555555555';
const HOST_LOCAL_KEY = 'host-local-key-0123456789abcdef0123456789abcdef';
const PORTAL_PUSH_KEY = 'ab'.repeat(32);
const PORTAL_URL = 'https://hub.ci.computer';
const ORGANIZATION_ID = 'org-1';
const HUB_HOST = 'hub.example.test';

const PERSON = (id: number, username: string, extra: Record<string, unknown> = {}) => ({
  id,
  username,
  totpEnabled: false,
  locale: 'en',
  operator: true,
  hasCompletedOnboarding: true,
  advancedMode: false,
  accessStatus: 'active',
  ...extra,
});
const freshUsers = (): Record<number, Record<string, unknown>> => ({
  1: PERSON(1, 'alice@example.com'),
  2: PERSON(2, 'bob@example.com', { totpEnabled: true }),
  3: PERSON(3, 'carol@example.com', { accessStatus: 'revoked' }),
  4: PERSON(4, 'dave@example.com'),
  5: PERSON(5, 'erin@example.com'),
});

const cache = new FakeCache();
const federated = new FakeFederatedIdentities();
const sessionUserCache = new SessionUserCache();
const sessionManager = new SessionManager(cache as unknown as CacheService);
let users = freshUsers();

const logger = mock<LoggerService>();
const userRepository = mock<UserRepository>();
const portal = mock<PortalClientService>();
const deviceRegistration = mock<DeviceRegistrationRepository>();
const apiKeys = mock<ApiKeyService>();
const forwardAuth = mock<ForwardAuthIdentityResolver>();
const config = mock<ConfigurationService>();
const configValues: Record<string, unknown> = {
  userSettings: { experimental: { insecureCookie: false } },
  jwtSecret: 'jwt-secret-for-the-http-test',
  hubLocalKey: HOST_LOCAL_KEY,
  ciHubApiKey: undefined,
  ciCloudUrl: PORTAL_URL,
  portalPushKeyPrefix: PORTAL_PUSH_KEY.slice(0, 8),
  portalPushKeyDeliveredAt: undefined,
};

function resetFakes() {
  users = freshUsers();
  cache.entries.clear();
  federated.rows = [];
  sessionUserCache.invalidate();
  vi.clearAllMocks();

  userRepository.getUserDtoById.mockImplementation((async (id: number) => users[Number(id)]) as never);
  userRepository.getUserById.mockImplementation((async (id: number) =>
    users[Number(id)] ? { ...users[Number(id)], totpSecret: 'ENC', salt: 'salt' } : undefined) as never);
  userRepository.getFirstOperator.mockImplementation((async () => users[1]) as never);
  userRepository.updateUser.mockImplementation((async (id: number, patch: Record<string, unknown>) => {
    Object.assign(users[id] as object, patch);
    sessionUserCache.invalidate(id);

    return users[id];
  }) as never);
  apiKeys.resolve.mockImplementation((async (token: string, scope: string) =>
    token === PORTAL_PUSH_KEY && scope === 'portal' ? { id: 1 } : null) as never);
  apiKeys.revokeCreatedBy.mockResolvedValue(undefined as never);
  forwardAuth.hubIssuer.mockResolvedValue(AUDIENCE);
  config.get.mockImplementation(((key: string) => configValues[key]) as never);
  config.getConfig.mockReturnValue({} as never);
  deviceRegistration.getFirstDeviceRegistration.mockResolvedValue({ id: ORGANIZATION_ID } as never);
  deviceRegistration.getDeviceRegistrationById.mockResolvedValue(null as never);
}

const FAKES = [
  { provide: CacheService, useValue: cache },
  { provide: LoggerService, useValue: logger },
  { provide: ConfigurationService, useValue: config },
  { provide: UserRepository, useValue: userRepository },
  { provide: FederatedIdentityRepository, useValue: federated },
  { provide: SessionManager, useValue: sessionManager },
  { provide: SessionUserCache, useValue: sessionUserCache },
  { provide: PortalClientService, useValue: portal },
  { provide: DeviceRegistrationRepository, useValue: deviceRegistration },
  { provide: ApiKeyService, useValue: apiKeys },
  { provide: ForwardAuthIdentityResolver, useValue: forwardAuth },
  { provide: ForwardAuthSecretResolver, useValue: mock<ForwardAuthSecretResolver>() },
  { provide: RegistrationService, useValue: mock<RegistrationService>() },
  { provide: BearerOrgMembershipCache, useValue: mock<BearerOrgMembershipCache>() },
  { provide: MemoryApiKeyCheck, useValue: mock<MemoryApiKeyCheck>() },
  { provide: ProxyTrustService, useValue: mock<ProxyTrustService>() },
  { provide: EncryptionService, useValue: mock<EncryptionService>() },
  { provide: FilesystemService, useValue: mock<FilesystemService>() },
  { provide: PasswordService, useValue: mock<PasswordService>() },
];

/** What `app.module.ts` registers beside the controllers: the middleware, the global pipe, the global filter. */
const APP_WIDE = [
  AuthMiddleware,
  { provide: APP_PIPE, useClass: ZodValidationPipe },
  { provide: APP_FILTER, useFactory: (l: LoggerService) => new MainExceptionFilter(l), inject: [LoggerService] },
];

@Module({
  controllers: [AuthController],
  providers: [...APP_WIDE, ...FAKES, AuthService, AuthRateLimiter, DidAuthService],
})
class HubModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*all');
  }
}

/** A controller with no `/auth/did/…` routes: what a Hub built without the feature serves. */
@Controller('auth')
class WithoutDidController {
  @Get('elsewhere')
  elsewhere() {
    return { elsewhere: true };
  }
}

@Module({ controllers: [WithoutDidController], providers: [...APP_WIDE, ...FAKES] })
class HubWithoutDidModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthMiddleware).forRoutes('*all');
  }
}

/** The parts of the bootstrap of `main.ts` that decide these answers (see the header for what is left out). */
async function boot(module: new () => unknown): Promise<{ app: INestApplication; port: number; moduleRef: TestingModule }> {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.setGlobalPrefix('/api');
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, origin?: string | boolean) => void) =>
      callback(null, resolveAllowedCorsOrigin(origin)),
    credentials: true,
  });
  app.use(cookieParser());
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));
  app.use(payloadTooLargeHandler);
  // `req.ip` is the first X-Forwarded-For hop, which is how each test gets a rate-limit budget of its own.
  (app.getHttpAdapter().getInstance() as { set: (key: string, value: unknown) => void }).set('trust proxy', true);
  await app.listen(0, '127.0.0.1');

  return { app, port: (app.getHttpServer().address() as AddressInfo).port, moduleRef };
}

// ── a client ─────────────────────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  setCookie: string[];
  text: string;
  json: any;
}
interface CallOptions {
  headers?: Record<string, string>;
  /** JSON-encoded unless `raw` is given. */
  body?: unknown;
  raw?: string;
  /** The second app, the one built without the routes. */
  twin?: boolean;
}

let hub: Awaited<ReturnType<typeof boot>>;
let twin: Awaited<ReturnType<typeof boot>>;
let clientNumber = 0;
let clientIp = '10.0.0.1';

function call(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string> = { 'x-forwarded-for': clientIp, ...options.headers };
    if (payload !== undefined) {
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const request = http.request({ host: '127.0.0.1', port: (options.twin ? twin : hub).port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          setCookie: (response.headers['set-cookie'] as string[] | undefined) ?? [],
          text,
          json: parsed,
        });
      });
    });
    request.on('error', reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

const api = {
  challenge: (body?: unknown, options: CallOptions = {}) => call('POST', '/api/auth/did/challenge', { body, ...options }),
  verify: (body?: unknown, options: CallOptions = {}) => call('POST', '/api/auth/did/verify', { body, ...options }),
  links: (options: CallOptions = {}) => call('GET', '/api/auth/did/links', options),
  link: (body?: unknown, options: CallOptions = {}) => call('POST', '/api/auth/did/link', { body, ...options }),
  unlink: (body?: unknown, options: CallOptions = {}) => call('DELETE', '/api/auth/did/link', { body, ...options }),
};

// ── people and keys ──────────────────────────────────────────────────────────────────────────────

const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url');

interface Identity {
  privateKey: KeyObject;
  did: string;
}
function newIdentity(): Identity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;

  return { privateKey, did: didKeyFromPublicKey(Buffer.from(x, 'base64url')) as string };
}

interface Challenge {
  challengeId: string;
  nonce: string;
  audience: string;
  purpose: 'sign-in' | 'link';
  expiresAt: number;
}

/** What a wallet does with a challenge: a self-issued ID token over its nonce and audience, signed by the DID's key. */
function tokenFor(who: Identity, challenge: Challenge, signer: Identity = who, length?: number) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: who.did, sub: who.did, aud: challenge.audience, nonce: challenge.nonce, iat: now, exp: now + 120 };
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const signingInput = `${header}.${length === undefined ? b64u(JSON.stringify(claims)) : paddedPayload(claims, length - header.length - 2 - ED25519_SIGNATURE_CHARS)}`;

  return `${signingInput}.${sign(null, Buffer.from(signingInput), signer.privateKey).toString('base64url')}`;
}

/** The base64url length of an Ed25519 signature. */
const ED25519_SIGNATURE_CHARS = 86;

/** A payload of EXACTLY `chars` base64url characters, made by padding an extra claim (4k+1 is not a length base64url has). */
function paddedPayload(claims: Record<string, unknown>, chars: number): string {
  const extra = ({ 0: 0, 2: 1, 3: 2 } as Record<number, number | undefined>)[chars % 4];
  if (extra === undefined) {
    throw new Error(`no payload is ${chars} base64url characters long`);
  }
  const bytes = Math.floor(chars / 4) * 3 + extra;
  const pad = bytes - JSON.stringify({ ...claims, pad: '' }).length;
  const payload = b64u(JSON.stringify({ ...claims, pad: 'p'.repeat(pad) }));
  if (pad < 0 || payload.length !== chars) {
    throw new Error(`cannot make a payload of ${chars} characters`);
  }

  return payload;
}

/** A challenge for `purpose` from the real route, and the body a client then posts back for `who`. */
async function proofFor(who: Identity, purpose: 'sign-in' | 'link' = 'sign-in', signer: Identity = who, length?: number) {
  const reply = await api.challenge({ purpose });
  expect(reply.status).toBe(201);
  const challenge = reply.json as Challenge;

  return { challenge, body: { challengeId: challenge.challengeId, idToken: tokenFor(who, challenge, signer, length) } };
}

const sessionFor = (userId: number) => sessionManager.createSession(userId);
const asSession = (sessionId: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${sessionId}` });

/** `who` linked to person `userId` through the real route, from a signed-in session. */
async function linkDid(userId: number, who: Identity) {
  const sessionId = await sessionFor(userId);
  const { body } = await proofFor(who, 'link');
  const reply = await api.link(body, { headers: asSession(sessionId) });
  expect(reply.status).toBe(201);

  return sessionId;
}

const CROSS_SITE = { code: 'AUTH_ERROR_DID_CROSS_SITE_REQUEST', status: 403 };

// ── the tests ────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  hub = await boot(HubModule);
  twin = await boot(HubWithoutDidModule);
});

afterAll(async () => {
  await hub?.app.close();
  await twin?.app.close();
});

beforeEach(() => {
  delete process.env[DID_AUTH_FLAG];
  resetFakes();
  clientNumber += 1;
  clientIp = `10.${(clientNumber >> 8) & 255}.${clientNumber & 255}.1`;
});

afterEach(() => {
  delete process.env[DID_AUTH_FLAG];
});

describe('Sign in with a DID — flag off', () => {
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
  const PROOF_BODY = { challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' };

  // Every shape of request a client could make to the five routes, as every kind of caller.
  const requests: Array<[string, string, string, CallOptions]> = [];
  for (const [method, path, body] of [
    ['POST', '/api/auth/did/challenge', undefined],
    ['POST', '/api/auth/did/verify', PROOF_BODY],
    ['GET', '/api/auth/did/links', undefined],
    ['POST', '/api/auth/did/link', PROOF_BODY],
    ['DELETE', '/api/auth/did/link', { did: 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw' }],
  ] as const) {
    requests.push([`${method} ${path} with a body`, method, path, { body }]);
    requests.push([`${method} ${path} with a body that is not valid`, method, path, { body: { nope: 1 } }]);
    requests.push([`${method} ${path} with malformed JSON`, method, path, { raw: '{"challengeId":' }]);
    requests.push([`${method} ${path} with a form body`, method, path, { raw: 'challengeId=x&idToken=y', headers: FORM }]);
    requests.push([`${method} ${path} with a foreign Origin`, method, path, { body, headers: { origin: 'https://evil.example' } }]);
  }
  // An absolute-form target (what a client sends through a forward proxy) keeps its scheme and host in the path Express hands
  // Nest's not-found handler; HEAD takes the route of the same path with GET.
  for (const [method, path] of [
    ['GET', '/api/auth/did/links'],
    ['POST', '/api/auth/did/challenge'],
    ['POST', '/api/auth/did/verify'],
    ['POST', '/api/auth/did/link'],
    ['DELETE', '/api/auth/did/link'],
  ] as const) {
    requests.push([`${method} ${path} as an absolute-form target`, method, `http://${HUB_HOST}${path}`, { body: method === 'GET' ? undefined : {} }]);
  }
  requests.push([
    'an absolute-form target over https with a port and a query that holds a URL',
    'GET',
    `https://${HUB_HOST}:8443/api/auth/did/links?x=1&next=http://evil.example/`,
    {},
  ]);
  requests.push(['an absolute-form target in upper case', 'GET', `HTTP://${HUB_HOST.toUpperCase()}/API/AUTH/DID/LINKS`, {}]);
  requests.push(['an origin-form target whose query holds a URL', 'GET', '/api/auth/did/links?next=http://evil.example/auth/did/links', {}]);
  // Express reads a backslash in an absolute-form target as a slash when the middleware mount matches, so the path its not-found handler
  // reports has the slash. The flag-off answer has to be built from the same string, and `http:///` is an empty host.
  requests.push(['POST of the link route as an absolute-form target that ends in a backslash', 'POST', 'http://h/api/auth/did/link\\', { body: {} }]);
  requests.push(['GET of the listing as an absolute-form target with backslashes for slashes', 'GET', 'http://h/api\\auth\\did\\links', {}]);
  requests.push(['GET of the listing as an absolute-form target with no host', 'GET', 'http:///api/auth/did/links', {}]);
  requests.push(['HEAD of the listing', 'HEAD', '/api/auth/did/links', {}]);
  requests.push(['HEAD of the listing as an absolute-form target', 'HEAD', `http://${HUB_HOST}/api/auth/did/links`, {}]);
  requests.push(['HEAD of a POST route', 'HEAD', '/api/auth/did/challenge', {}]);
  requests.push(['PUT of the link route', 'PUT', '/api/auth/did/link', { body: {} }]);
  requests.push(['PATCH of the listing', 'PATCH', '/api/auth/did/links', { body: {} }]);
  requests.push(['a query string', 'GET', '/api/auth/did/links?x=1&y=%20z', {}]);
  requests.push(['a trailing slash', 'GET', '/api/auth/did/links/', {}]);
  requests.push(['another case', 'GET', '/API/Auth/DID/Links', {}]);
  requests.push(['another case with a query', 'POST', '/api/AUTH/did/Challenge?a=b', { body: {} }]);
  requests.push([
    'a preflight from a foreign origin',
    'OPTIONS',
    '/api/auth/did/link',
    {
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    },
  ]);
  requests.push([
    'a preflight from the desktop shell',
    'OPTIONS',
    '/api/auth/did/verify',
    {
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    },
  ]);

  /** The headers that identify the answer, without the clock. */
  const stable = (reply: Reply) => ({ ...reply.headers, date: undefined });

  describe.each([
    ['an anonymous caller', () => ({})],
    ['a signed-in person', async () => asSession(await sessionFor(1))],
    ['the host-local key', () => ({ authorization: `Bearer ${HOST_LOCAL_KEY}` })],
    ['the Portal push key', () => ({ authorization: `Bearer ${PORTAL_PUSH_KEY}` })],
  ])('as %s', (_who, credentials) => {
    it.each(requests)('%s answers exactly what a Hub with no such routes answers', async (_name, method, path, options) => {
      const headers = { ...(await credentials()), ...options.headers };

      const flagOff = await call(method, path, { ...options, headers });
      const absent = await call(method, path, { ...options, headers, twin: true });

      expect(flagOff.status).toBe(absent.status);
      expect(flagOff.text).toBe(absent.text);
      expect(stable(flagOff)).toEqual(stable(absent));
      expect(flagOff.setCookie).toEqual([]);
    });
  });

  it('answers 404 with the unknown-route body to a route a Hub with the feature on would serve, to anyone', async () => {
    const reply = await api.links({ headers: asSession(await sessionFor(1)) });

    // The oracle is a genuine 404 of an unknown path, not a guess about what one looks like.
    const unknown = await call('GET', '/api/auth/did/not-a-route', { twin: true });
    expect(unknown.status).toBe(404);
    expect(reply.status).toBe(404);
    expect(reply.json).toEqual({ statusCode: 404, message: 'Cannot GET /api/auth/did/links', path: '/auth/did/links' });
  });

  it('answers 404 to a signed-out caller as well, not the 401 the session guard would give', async () => {
    expect((await api.links()).status).toBe(404);
    expect((await api.link(PROOF_BODY)).status).toBe(404);
    expect((await api.unlink({ did: 'did:key:x' })).status).toBe(404);
  });

  it('creates nothing and spends nothing', async () => {
    await api.challenge();
    await api.verify(PROOF_BODY);
    await api.link(PROOF_BODY, { headers: asSession(await sessionFor(1)) });

    expect([...cache.entries.keys()].filter((key) => key.startsWith('did-auth:'))).toEqual([]);
    expect(federated.rows).toEqual([]);
    expect(userRepository.createUser).not.toHaveBeenCalled();
    expect(userRepository.createFirstOperator).not.toHaveBeenCalled();
  });

  it('reads the process environment on every request: on when it says "true", off again when it does not', async () => {
    // Only code in this process can change it. A running Hub's environment is fixed when it starts, so for an operator this is
    // a restart (or a recreated container), not a switch.
    expect((await api.challenge()).status).toBe(404);

    process.env[DID_AUTH_FLAG] = 'true';
    expect((await api.challenge()).status).toBe(201);

    process.env[DID_AUTH_FLAG] = 'TRUE';
    expect((await api.challenge()).status).toBe(404);

    delete process.env[DID_AUTH_FLAG];
    expect((await api.challenge()).status).toBe(404);
  });
});

describe('Sign in with a DID — flag on', () => {
  beforeEach(() => {
    process.env[DID_AUTH_FLAG] = 'true';
  });

  describe('POST /api/auth/did/challenge', () => {
    it('hands an anonymous caller a challenge for signing in, naming this Hub and nobody else', async () => {
      const reply = await api.challenge();

      expect(reply.status).toBe(201);
      expect(reply.setCookie).toEqual([]);
      expect(Object.keys(reply.json).sort()).toEqual(['audience', 'challengeId', 'expiresAt', 'nonce', 'purpose']);
      expect(reply.json).toMatchObject({ audience: AUDIENCE, purpose: 'sign-in' });
      expect(reply.json.challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Buffer.from(reply.json.nonce, 'base64url').length).toBeGreaterThanOrEqual(16);
      expect(Math.abs(reply.json.expiresAt - (Date.now() + 120_000))).toBeLessThan(5_000);
    });

    it('takes a JSON body, and an empty one, and asks for a link when told to', async () => {
      expect((await api.challenge({})).json.purpose).toBe('sign-in');
      expect((await api.challenge({ purpose: 'sign-in' })).json.purpose).toBe('sign-in');
      expect((await api.challenge({ purpose: 'link' })).json.purpose).toBe('link');
    });

    it.each([[{ purpose: 'unlink' }], [{ purpose: 5 }], [{ purpose: null }], [[1, 2]]])('refuses the body %j with a 400', async (body) => {
      const reply = await api.challenge(body);

      expect(reply.status).toBe(400);
      expect([...cache.entries.keys()].filter((key) => key.startsWith('did-auth:'))).toEqual([]);
    });

    it('lets a client ask for 20 a minute and answers the 21st with a 429', async () => {
      for (let i = 0; i < 20; i++) {
        expect((await api.challenge()).status).toBe(201);
      }

      const over = await api.challenge();

      expect(over.status).toBe(429);
      expect(over.json.message).toBe('AUTH_ERROR_RATE_LIMITED');
    });

    it('answers 503 with a key when the Hub cannot read its own issuer', async () => {
      forwardAuth.hubIssuer.mockRejectedValueOnce(new Error('user_directory has no row'));

      const reply = await api.challenge();

      expect(reply.status).toBe(503);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_UNAVAILABLE');
    });
  });

  describe('POST /api/auth/did/link', () => {
    it('is refused with a 401 to someone who is not signed in', async () => {
      const { body } = await proofFor(newIdentity(), 'link');

      const reply = await api.link(body);

      expect(reply.status).toBe(401);
      expect(reply.json.message).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
      expect(federated.rows).toEqual([]);
    });

    it('links the DID a signed-in person proved they hold, to that person: no email, nothing verified', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'link');

      const reply = await api.link(body, { headers: asSession(sessionId) });

      expect(reply.status).toBe(201);
      expect(reply.json).toEqual({ success: true, did: key.did });
      expect(federated.rows).toEqual([
        expect.objectContaining({ userId: 1, issuer: 'did:key', subject: key.did, email: null, emailVerified: false }),
      ]);
    });

    it('lists it, and only for the person who linked it', async () => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);

      const own = await api.links({ headers: asSession(sessionId) });
      const other = await api.links({ headers: asSession(await sessionFor(5)) });

      expect(own.status).toBe(200);
      expect(own.json).toEqual({ links: [{ did: key.did, linkedAt: expect.any(String) }] });
      expect(other.json).toEqual({ links: [] });
    });

    it('is idempotent for the person who already holds the link', async () => {
      const key = newIdentity();
      await linkDid(1, key);

      await linkDid(1, key);

      expect(federated.rows).toHaveLength(1);
    });

    it('refuses a DID that is bound to another person with a 409 that does not say who', async () => {
      const key = newIdentity();
      await linkDid(5, key);
      const { body } = await proofFor(key, 'link');

      const reply = await api.link(body, { headers: asSession(await sessionFor(1)) });

      expect(reply.status).toBe(409);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_ALREADY_LINKED');
      expect(reply.text).not.toMatch(/erin|"5"|userId/);
      expect(federated.rows).toEqual([expect.objectContaining({ userId: 5 })]);
    });

    it('answers a proof that does not verify with a 400, never a 401, and the person stays signed in', async () => {
      // The SPA reads any 401 as "your session ended". A wallet that signed wrongly must not end it.
      const claimed = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(claimed, 'link', newIdentity());

      const reply = await api.link(body, { headers: asSession(sessionId) });

      expect(reply.status).toBe(400);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_PROOF_REFUSED');
      expect(federated.rows).toEqual([]);
      expect((await api.links({ headers: asSession(sessionId) })).status).toBe(200);
    });

    it('refuses a proof made for signing in, and the challenge is spent', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'sign-in');

      const reply = await api.link(body, { headers: asSession(sessionId) });
      const again = await api.link(body, { headers: asSession(sessionId) });

      expect(reply.status).toBe(400);
      expect(again.status).toBe(400);
      expect(federated.rows).toEqual([]);
    });

    it('reads a proof once: the same one cannot link a second time', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'link');

      expect((await api.link(body, { headers: asSession(sessionId) })).status).toBe(201);
      await api.unlink({ did: key.did }, { headers: asSession(sessionId) });

      expect((await api.link(body, { headers: asSession(sessionId) })).status).toBe(400);
      expect(federated.rows).toEqual([]);
    });

    it('stops reading proofs from a client that keeps presenting bad ones: ten, then a 429', async () => {
      const sessionId = await sessionFor(1);
      const headers = asSession(sessionId);

      for (let i = 0; i < 10; i++) {
        expect((await api.link({ challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' }, { headers })).status).toBe(400);
      }
      const { body } = await proofFor(newIdentity(), 'link');
      const over = await api.link(body, { headers });

      expect(over.status).toBe(429);
      expect(over.json.message).toBe('AUTH_ERROR_RATE_LIMITED');
    });
  });

  describe('POST /api/auth/did/verify', () => {
    it('signs in the person the DID is linked to: a session cookie, and the session is theirs', async () => {
      const key = newIdentity();
      await linkDid(1, key);
      const { body } = await proofFor(key);

      const reply = await api.verify(body);

      expect(reply.status).toBe(201);
      expect(reply.json).toEqual({ success: true, sessionId: expect.any(String) });
      expect(reply.setCookie).toHaveLength(1);
      expect(reply.setCookie[0]).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=${reply.json.sessionId};`));
      expect(reply.setCookie[0]).toMatch(/HttpOnly/i);
      expect(reply.setCookie[0]).toMatch(/SameSite=Lax/i);
      expect(sessionManager.resolveSessionUserId(reply.json.sessionId)).toBe(1);
      const signedIn = await api.links({ headers: asSession(reply.json.sessionId) });
      expect(signedIn.json).toEqual({ links: [{ did: key.did, linkedAt: expect.any(String) }] });
    });

    it('creates no person, no binding and no session for a DID nobody linked: 403 and a code', async () => {
      const stranger = newIdentity();
      const { body } = await proofFor(stranger);
      const sessionsBefore = [...cache.entries.keys()].filter((key) => key.startsWith('session')).length;

      const reply = await api.verify(body);

      expect(reply.status).toBe(403);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_NOT_LINKED');
      expect(reply.setCookie).toEqual([]);
      expect(federated.rows).toEqual([]);
      expect(userRepository.createUser).not.toHaveBeenCalled();
      expect(userRepository.createFirstOperator).not.toHaveBeenCalled();
      expect([...cache.entries.keys()].filter((key) => key.startsWith('session')).length).toBe(sessionsBefore);
    });

    it('answers a wrong key, a replay and a proof made for linking with one and the same 401', async () => {
      const key = newIdentity();
      await linkDid(1, key);
      const good = await proofFor(key);
      const wrongKey = await api.verify((await proofFor(key, 'sign-in', newIdentity())).body);
      const first = await api.verify(good.body);
      const replay = await api.verify(good.body);
      const forLinking = await api.verify((await proofFor(key, 'link')).body);

      expect(first.status).toBe(201);
      for (const reply of [wrongKey, replay, forLinking]) {
        expect(reply.status).toBe(401);
        expect(reply.json).toEqual({ statusCode: 401, message: 'AUTH_ERROR_DID_SIGN_IN_REFUSED', path: '/api/auth/did/verify' });
        expect(reply.setCookie).toEqual([]);
      }
    });

    it('spends a link challenge it was wrongly given: the proof cannot then link either', async () => {
      const key = newIdentity();
      const { body } = await proofFor(key, 'link');

      await api.verify(body);

      expect((await api.link(body, { headers: asSession(await sessionFor(1)) })).status).toBe(400);
      expect(federated.rows).toEqual([]);
    });

    it('answers a revoked person exactly as it answers a proof that did not verify', async () => {
      const key = newIdentity();
      await linkDid(5, key);
      // Revoked after linking: a revoked person cannot link, but the link outlives the revocation.
      await userRepository.updateUser(5, { accessStatus: 'revoked' } as never);
      const revoked = await api.verify((await proofFor(key)).body);
      const unverified = await api.verify((await proofFor(key, 'sign-in', newIdentity())).body);

      expect(revoked.status).toBe(401);
      expect(revoked.text).toBe(unverified.text);
      expect(revoked.setCookie).toEqual([]);
    });

    it('keeps the second factor: a person with TOTP gets a TOTP step, not a session', async () => {
      const key = newIdentity();
      await linkDid(2, key);

      const reply = await api.verify((await proofFor(key)).body);

      expect(reply.status).toBe(201);
      expect(reply.json).toEqual({ success: true, totpSessionId: expect.any(String) });
      expect(reply.setCookie).toEqual([]);
    });

    it('wants JSON: a form post is refused with a 415 before the challenge is read', async () => {
      const key = newIdentity();
      await linkDid(1, key);
      const { body } = await proofFor(key);
      const asForm = `challengeId=${body.challengeId}&idToken=${body.idToken}`;

      const refused = await call('POST', '/api/auth/did/verify', { raw: asForm, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const text = await call('POST', '/api/auth/did/verify', { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } });

      expect(refused.status).toBe(415);
      expect(refused.json.message).toBe('AUTH_ERROR_DID_JSON_REQUIRED');
      expect(text.status).toBe(415);
      // Neither spent the challenge.
      expect((await api.verify(body)).status).toBe(201);
    });

    it('stops answering a client that keeps presenting bad proofs: ten 401s, then a 429', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await api.verify({ challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' })).status).toBe(401);
      }

      const over = await api.verify({ challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' });

      expect(over.status).toBe(429);
    });

    it('does not limit people who sign in: a dozen from one client all get in', async () => {
      const key = newIdentity();
      await linkDid(1, key);

      for (let i = 0; i < 12; i++) {
        expect((await api.verify((await proofFor(key)).body)).status).toBe(201);
      }
    });

    describe('asks Portal whether a Portal-linked person is still in the organization', () => {
      const subject = 'portal-sub-dave';

      const daveWithBothLinks = async () => {
        federated.rows.push({
          id: 90,
          userId: 4,
          issuer: PORTAL_URL,
          subject,
          email: 'dave@example.com',
          emailVerified: true,
          createdAt: '2026-01-01 00:00:00',
        });
        const key = newIdentity();
        await linkDid(4, key);

        return key;
      };

      it('refuses a person Portal says is no longer a member: 403, no session, the person revoked, and Portal asked about the Portal subject', async () => {
        const key = await daveWithBothLinks();
        portal.whoisApps.mockResolvedValue({ status: 403, code: 'GRANT_DENIED', body: undefined } as never);

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(403);
        expect(reply.json.message).toBe('AUTH_ERROR_NOT_ORG_MEMBER');
        expect(reply.setCookie).toEqual([]);
        expect(users[4]?.accessStatus).toBe('revoked');
        expect(portal.whoisApps).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subject, organizationId: ORGANIZATION_ID }));
        // And the next attempt is the ordinary revoked answer.
        expect((await api.verify((await proofFor(key)).body)).status).toBe(401);
      });

      it('lets a member in, and records that Portal confirmed them', async () => {
        const key = await daveWithBothLinks();
        portal.whoisApps.mockResolvedValue({
          status: 200,
          body: { organizations: [{ organizationId: ORGANIZATION_ID, user: { role: 'admin' }, apps: [] }] },
        } as never);

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(201);
        expect(reply.json.sessionId).toEqual(expect.any(String));
        expect(users[4]).toMatchObject({ accessStatus: 'active', orgRole: 'admin' });
      });

      it('lets the person in when Portal cannot be reached, as an existing Portal link is let in offline', async () => {
        const key = await daveWithBothLinks();
        portal.whoisApps.mockRejectedValue(new Error('connect ECONNREFUSED'));

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(201);
        expect(portal.whoisApps).toHaveBeenCalledTimes(1);
        expect(users[4]?.accessStatus).toBe('active');
      });

      it('does not ask Portal about a person with no Portal link: their DID is not a Portal subject', async () => {
        const key = newIdentity();
        await linkDid(1, key);

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(201);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });

      it('counts a "not a member" refusal against the failure budget like any other: ten, then a 429', async () => {
        // The slot of a `failures` scope is handed back only when the person is let in, so a 403 from the membership check keeps it.
        const key = await daveWithBothLinks();
        portal.whoisApps.mockResolvedValue({ status: 403, code: 'GRANT_DENIED', body: undefined } as never);
        const putBack = () => userRepository.updateUser(4, { accessStatus: 'active' } as never);

        for (let i = 0; i < 10; i += 1) {
          // Each refusal revokes the person; they are put back so the next proof meets the same answer.
          await putBack();
          expect((await api.verify((await proofFor(key)).body)).status).toBe(403);
        }
        await putBack();
        const over = await api.verify((await proofFor(key)).body);

        expect(over.status).toBe(429);
        expect(over.json.message).toBe('AUTH_ERROR_RATE_LIMITED');
      });

      it('lets the person in when the registration cannot be read: an unreadable registration is "unknown", as on the password path', async () => {
        const key = await daveWithBothLinks();
        deviceRegistration.getFirstDeviceRegistration.mockRejectedValue(new Error('ci-hub-db went away'));

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(201);
        expect(portal.whoisApps).not.toHaveBeenCalled();
        expect(users[4]?.accessStatus).toBe('active');
      });

      it('asks about a link from another Portal when that is the only Portal link, and revokes on a definitive "not a member"', async () => {
        // A person who moved the Hub to another Portal: the paired Portal has never heard of the old subject. The sweep and the refresh
        // have always asked about it (#2178), and so does this path, so the DID is no way round a removal.
        federated.rows.push({
          id: 91,
          userId: 4,
          issuer: 'https://old.example.com/api/auth',
          subject: 'sub-at-old-portal',
          email: 'dave@example.com',
          emailVerified: true,
          createdAt: '2026-01-01 00:00:00',
        });
        const key = newIdentity();
        await linkDid(4, key);
        portal.whoisApps.mockResolvedValue({ status: 403, code: 'GRANT_DENIED', body: undefined } as never);

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(403);
        expect(reply.json.message).toBe('AUTH_ERROR_NOT_ORG_MEMBER');
        expect(portal.whoisApps).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subject: 'sub-at-old-portal' }));
        expect(users[4]?.accessStatus).toBe('revoked');
      });

      it('does not ask Portal on a Hub that is not paired to an organization', async () => {
        const key = await daveWithBothLinks();
        deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(null as never);

        const reply = await api.verify((await proofFor(key)).body);

        expect(reply.status).toBe(201);
        expect(portal.whoisApps).not.toHaveBeenCalled();
      });
    });
  });

  describe('DELETE /api/auth/did/link', () => {
    it('removes the signed-in person’s own link, and the DID then signs nobody in', async () => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);

      const reply = await api.unlink({ did: key.did }, { headers: asSession(sessionId) });

      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ success: true, did: key.did });
      expect(federated.rows).toEqual([]);
      expect((await api.verify((await proofFor(key)).body)).status).toBe(403);
    });

    it('answers 404 for a DID the person has not linked, whoever else holds it, and leaves the other person’s link alone', async () => {
      const key = newIdentity();
      await linkDid(5, key);

      const reply = await api.unlink({ did: key.did }, { headers: asSession(await sessionFor(1)) });

      expect(reply.status).toBe(404);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_LINK_NOT_FOUND');
      expect(federated.rows).toEqual([expect.objectContaining({ userId: 5, subject: key.did })]);
    });

    it('answers 404 for a string that is no DID at all, and 400 for a body with no did', async () => {
      const headers = asSession(await sessionFor(1));

      expect((await api.unlink({ did: 'not-a-did' }, { headers })).status).toBe(404);
      expect((await api.unlink({}, { headers })).status).toBe(400);
      expect((await api.unlink({ did: 'x'.repeat(201) }, { headers })).status).toBe(400);
    });

    it('wants JSON: a form post is refused with a 415 and removes nothing', async () => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);

      const reply = await call('DELETE', '/api/auth/did/link', {
        raw: `did=${encodeURIComponent(key.did)}`,
        headers: { ...asSession(sessionId), 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(reply.status).toBe(415);
      expect(reply.json.message).toBe('AUTH_ERROR_DID_JSON_REQUIRED');
      expect(federated.rows).toHaveLength(1);
    });
  });

  describe('in demo mode', () => {
    // The shared DemoModeGuard answers with the key `SERVER_ERROR_NOT_ALLOWED_IN_DEMO` and the status the shared helper
    // gives it (500: `TranslatableError`'s default), as on every other route that uses it. The key is what is pinned here.
    afterEach(() => {
      delete configValues.demoMode;
    });

    it('refuses to link a DID to the shared demo user, writes nothing, and leaves the proof unread', async () => {
      const key = newIdentity();
      const headers = asSession(await sessionFor(1));
      const { body } = await proofFor(key, 'link');
      configValues.demoMode = true;

      const reply = await api.link(body, { headers });

      expect(reply.json.message).toBe('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(federated.rows).toEqual([]);
      // The guard answered before the challenge was read, so the same proof links once demo mode is off.
      delete configValues.demoMode;
      expect((await api.link(body, { headers })).status).toBe(201);
    });

    it('refuses to remove a link, so demo mode freezes the links as it freezes the password and the username', async () => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);
      configValues.demoMode = true;

      const reply = await api.unlink({ did: key.did }, { headers: asSession(sessionId) });

      expect(reply.json.message).toBe('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
      expect(federated.rows).toHaveLength(1);
    });

    it('still lists links and still asks for a challenge: only the two routes that change a link are refused', async () => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);
      configValues.demoMode = true;

      expect((await api.links({ headers: asSession(sessionId) })).json).toEqual({ links: [{ did: key.did, linkedAt: expect.any(String) }] });
      expect((await api.challenge()).status).toBe(201);
    });
  });

  describe('a page on another origin cannot link or unlink with the person’s cookie', () => {
    const FOREIGN: Array<[string, Record<string, string>]> = [
      ['a foreign https origin', { origin: 'https://evil.example', host: HUB_HOST }],
      ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site', host: HUB_HOST }],
      ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site', host: HUB_HOST }],
      [
        'a sibling port on a plain-http LAN address, where the browser sends no Sec-Fetch-Site',
        { origin: 'http://192.168.1.10:3001', host: '192.168.1.10:3000' },
      ],
      ['a sibling host', { origin: 'https://other.example.test', host: HUB_HOST }],
      ['a null origin (a sandboxed frame)', { origin: 'null', host: HUB_HOST }],
      ['the desktop shell’s origin', { origin: 'tauri://localhost', host: HUB_HOST }],
      ['an origin that is not the host a proxy forwarded', { origin: 'https://backend:3000', host: 'backend:3000', 'x-forwarded-host': HUB_HOST }],
    ];

    it.each(FOREIGN)('refuses a link from %s, and the proof is still good afterwards', async (_name, headers) => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'link');

      const refused = await api.link(body, { headers: { ...asSession(sessionId), ...headers } });

      expect(refused).toMatchObject({ status: CROSS_SITE.status });
      expect(refused.json.message).toBe(CROSS_SITE.code);
      expect(federated.rows).toEqual([]);
      // The refusal came before the challenge was read, so the person’s own page can still use it.
      expect((await api.link(body, { headers: asSession(sessionId) })).status).toBe(201);
    });

    it.each(FOREIGN)('refuses an unlink from %s, and the link stays', async (_name, headers) => {
      const key = newIdentity();
      const sessionId = await linkDid(1, key);

      const refused = await api.unlink({ did: key.did }, { headers: { ...asSession(sessionId), ...headers } });

      expect(refused.status).toBe(403);
      expect(refused.json.message).toBe(CROSS_SITE.code);
      expect(federated.rows).toHaveLength(1);
    });

    it('refuses a form post from another origin, which a browser sends with the cookie and no preflight', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'link');

      const refused = await call('POST', '/api/auth/did/link', {
        raw: `challengeId=${body.challengeId}&idToken=${body.idToken}`,
        headers: { ...asSession(sessionId), 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', host: HUB_HOST },
      });

      expect(refused.status).toBe(403);
      expect(federated.rows).toEqual([]);
    });

    it('refuses a form post that carries no Origin at all, because only JSON is read', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const { body } = await proofFor(key, 'link');

      const refused = await call('POST', '/api/auth/did/link', {
        raw: `challengeId=${body.challengeId}&idToken=${body.idToken}`,
        headers: { ...asSession(sessionId), 'content-type': 'application/x-www-form-urlencoded' },
      });

      expect(refused.status).toBe(415);
      expect(federated.rows).toEqual([]);
    });

    it('does not answer a foreign origin’s preflight with permission, so a script from there cannot send JSON either', async () => {
      const preflight = await call('OPTIONS', '/api/auth/did/link', {
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });

      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('lets the Hub’s own pages through, however the proxy in front of it presents the host', async () => {
      const key = newIdentity();
      const sessionId = await sessionFor(1);
      const own: Array<Record<string, string>> = [
        { origin: `https://${HUB_HOST}`, host: HUB_HOST },
        { origin: `https://${HUB_HOST}:443`, host: HUB_HOST },
        { origin: `https://${HUB_HOST}`, host: 'backend:3000', 'x-forwarded-host': HUB_HOST },
        { origin: 'http://192.168.1.10:3000', host: '192.168.1.10:3000' },
        { 'sec-fetch-site': 'same-origin', origin: `https://${HUB_HOST}`, host: HUB_HOST },
      ];

      for (const headers of own) {
        const { body } = await proofFor(key, 'link');
        const reply = await api.link(body, { headers: { ...asSession(sessionId), ...headers } });

        expect(reply.status, JSON.stringify(headers)).toBe(201);
      }
    });

    it('lets a client with no browser headers through: curl, the CLI', async () => {
      const key = newIdentity();
      const { body } = await proofFor(key, 'link');

      const reply = await api.link(body, { headers: asSession(await sessionFor(1)) });

      expect(reply.status).toBe(201);
    });

    it('lets a foreign origin READ nothing here either: the listing needs the cookie and is answered to its own page only', async () => {
      // A listing changes nothing, so it is not cross-site checked; what stops a page on another origin
      // reading the answer is the browser: this origin is not in the CORS allow-list.
      const reply = await api.links({ headers: { ...asSession(await sessionFor(1)), origin: 'https://evil.example', host: HUB_HOST } });

      expect(reply.status).toBe(200);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('the global validation pipe answers a malformed body before any challenge is read', () => {
    // Every body names the GENUINE challenge where it can. With the pipe bypassed the service would read that challenge and refuse
    // with a key of its own; with the pipe running the challenge is untouched. So a 400 whose message is not one of the service's
    // keys, followed by the genuine proof still working, can only be the pipe's. A refused proof on /did/link is itself a 400, so
    // the status alone shows nothing there.
    const SERVICE_KEYS = ['AUTH_ERROR_DID_PROOF_REFUSED', 'AUTH_ERROR_DID_SIGN_IN_REFUSED'];
    const BAD_BODIES: Array<[string, (challenge: Challenge) => Record<string, unknown>]> = [
      ['an empty idToken', (c) => ({ challengeId: c.challengeId, idToken: '' })],
      ['an idToken of 4097 characters', (c) => ({ challengeId: c.challengeId, idToken: 'a'.repeat(4097) })],
      ['a number for the idToken', (c) => ({ challengeId: c.challengeId, idToken: 5 })],
      ['no idToken', (c) => ({ challengeId: c.challengeId })],
      ['a challengeId of 65 characters', (c) => ({ challengeId: `${c.challengeId}${'x'.repeat(29)}`, idToken: 'a.b.c' })],
      ['an empty challengeId', () => ({ challengeId: '', idToken: 'a.b.c' })],
      ['no challengeId', () => ({ idToken: 'a.b.c' })],
    ];

    describe.each([
      ['POST /did/link', 'link' as const],
      ['POST /did/verify', 'sign-in' as const],
    ])('%s', (_route, purpose) => {
      const send = (body: unknown, sessionId: string) => (purpose === 'link' ? api.link(body, { headers: asSession(sessionId) }) : api.verify(body));

      it.each(BAD_BODIES)('answers %s with the pipe: a 400 that is not the service’s key, and the genuine proof still works', async (_name, make) => {
        const key = newIdentity();
        const sessionId = await sessionFor(1);
        if (purpose === 'sign-in') {
          await linkDid(1, key);
        }
        const real = await proofFor(key, purpose);

        const reply = await send(make(real.challenge), sessionId);

        expect(reply.status).toBe(400);
        expect(SERVICE_KEYS).not.toContain(reply.json.message);
        expect((await send(real.body, sessionId)).status).toBe(201);
      });

      it('lets a challengeId of exactly 64 characters through to the service, which finds no such challenge', async () => {
        const reply = await send({ challengeId: 'x'.repeat(64), idToken: 'a.b.c' }, await sessionFor(1));

        expect(SERVICE_KEYS).toContain(reply.json.message);
      });

      it('lets a token of exactly 4096 characters through to the service, which reads it', async () => {
        const key = newIdentity();
        const sessionId = await sessionFor(1);
        if (purpose === 'sign-in') {
          await linkDid(1, key);
        }
        const { body } = await proofFor(key, purpose, key, 4096);
        expect(body.idToken).toHaveLength(4096);

        const reply = await send(body, sessionId);

        expect(reply.status).toBe(201);
      });
    });

    it('answers an empty did on unlink with the pipe (400), and one of 200 characters with the service (404)', async () => {
      const headers = asSession(await sessionFor(1));

      const empty = await api.unlink({ did: '' }, { headers });
      const longest = await api.unlink({ did: 'x'.repeat(200) }, { headers });

      expect(empty.status).toBe(400);
      expect(empty.json.message).not.toBe('AUTH_ERROR_DID_LINK_NOT_FOUND');
      expect(longest.status).toBe(404);
      expect(longest.json.message).toBe('AUTH_ERROR_DID_LINK_NOT_FOUND');
    });
  });

  describe('the session cookie a sign-in sets', () => {
    const signIn = async (headers: Record<string, string> = {}) => {
      const key = newIdentity();
      await linkDid(1, key);

      return api.verify((await proofFor(key)).body, { headers });
    };

    it('is the cookie every sign-in sets behind an https proxy: Secure, for the whole site, for seven days, on the Hub’s domain', async () => {
      const reply = await signIn({ 'x-forwarded-proto': 'https', 'x-forwarded-host': HUB_HOST });

      expect(reply.status).toBe(201);
      expect(reply.setCookie).toHaveLength(1);
      expect(reply.setCookie[0]).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=${reply.json.sessionId};`));
      expect(reply.setCookie[0]).toMatch(/; Max-Age=604800;/);
      expect(reply.setCookie[0]).toMatch(/; Path=\/;/);
      expect(reply.setCookie[0]).toMatch(/; Domain=\.hub\.example\.test;/);
      expect(reply.setCookie[0]).toMatch(/; HttpOnly/);
      expect(reply.setCookie[0]).toMatch(/; Secure/);
      expect(reply.setCookie[0]).toMatch(/; SameSite=Lax/);
    });

    it('is not Secure, and has no Domain, when the request did not come over https through the proxy', async () => {
      const reply = await signIn();

      expect(reply.setCookie[0]).not.toMatch(/; Secure/);
      expect(reply.setCookie[0]).not.toMatch(/; Domain=/);
      expect(reply.setCookie[0]).toMatch(/; Max-Age=604800;/);
    });
  });

  describe('rate limits', () => {
    let limiter: AuthRateLimiter;
    let now: number;

    beforeEach(() => {
      // The limiter's own clock, not the DID service's: a window is the limiter's to keep.
      limiter = hub.moduleRef.get(AuthRateLimiter);
      now = 1_800_000_000_000;
      limiter.now = () => now;
    });
    afterEach(() => {
      limiter.now = Date.now;
    });

    const BAD = { challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' };
    /** Use up a scope the way ten failures do, without going through the route that owns it. */
    const exhaust = (scope: 'login' | 'totp') => {
      for (let i = 0; i < 10; i += 1) {
        limiter.admit(scope, clientIp);
      }
    };

    it('frees the sign-in budget after exactly a minute: ten failures, a 429 until 60 s have passed, a 401 again at 60 s', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await api.verify(BAD)).status).toBe(401);
      }
      expect((await api.verify(BAD)).status).toBe(429);

      now += 59_999;
      expect((await api.verify(BAD)).status).toBe(429);
      now += 1;
      expect((await api.verify(BAD)).status).toBe(401);
    });

    it('frees the challenge budget after exactly a minute: twenty, a 429 until 60 s have passed, a 201 again at 60 s', async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await api.challenge()).status).toBe(201);
      }
      expect((await api.challenge()).status).toBe(429);

      now += 59_999;
      expect((await api.challenge()).status).toBe(429);
      now += 1;
      expect((await api.challenge()).status).toBe(201);
    });

    it('draws link and verify from one budget of ten failures: five of each, and the eleventh of either is a 429', async () => {
      const headers = asSession(await sessionFor(1));
      for (let i = 0; i < 5; i += 1) {
        expect((await api.verify(BAD)).status).toBe(401);
        expect((await api.link(BAD, { headers })).status).toBe(400);
      }

      expect((await api.verify(BAD)).status).toBe(429);
      expect((await api.link(BAD, { headers })).status).toBe(429);
    });

    it('keeps the DID budgets apart from the password and TOTP ones: using those up leaves every DID route answering', async () => {
      const headers = asSession(await sessionFor(1));
      exhaust('login');
      exhaust('totp');

      expect((await api.verify(BAD)).status).toBe(401);
      expect((await api.link(BAD, { headers })).status).toBe(400);
      expect((await api.challenge()).status).toBe(201);
    });

    it('and keeps the password and TOTP budgets out of the DID ones: ten failed proofs leave both with all of theirs', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await api.verify(BAD)).status).toBe(401);
      }
      expect((await api.verify(BAD)).status).toBe(429);

      expect(() => exhaust('login')).not.toThrow();
      expect(() => exhaust('totp')).not.toThrow();
    });
  });

  describe('is for a person’s own session, not a machine credential', () => {
    const MACHINES: Array<[string, Record<string, string>]> = [
      ['the host-local key', { authorization: `Bearer ${HOST_LOCAL_KEY}` }],
      ['the Portal push key', { authorization: `Bearer ${PORTAL_PUSH_KEY}` }],
    ];

    it.each(MACHINES)('refuses %s on every route that acts for a person, with a 403 and a code', async (_name, headers) => {
      const key = newIdentity();
      const { body } = await proofFor(key, 'link');

      for (const reply of [await api.links({ headers }), await api.link(body, { headers }), await api.unlink({ did: key.did }, { headers })]) {
        expect(reply.status).toBe(403);
        expect(reply.json.message).toBe('AUTH_ERROR_SIGNED_IN_PERSON_REQUIRED');
      }
      expect(federated.rows).toEqual([]);
      // The refusal came first, so the challenge was never read.
      expect((await api.link(body, { headers: asSession(await sessionFor(1)) })).status).toBe(201);
    });

    it('answers a signed-out caller 401 on the listing', async () => {
      const reply = await api.links();

      expect(reply.status).toBe(401);
      expect(reply.json.message).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    });
  });

  describe('the status codes a single-page client reads', () => {
    it('answers 401 on a link route only when there is no session, never because a proof, a key or a header was wrong', async () => {
      const sessionId = await sessionFor(1);
      const headers = asSession(sessionId);
      const key = newIdentity();
      const other = newIdentity();
      await linkDid(5, other);
      const refusals = [
        await api.link({ challengeId: '11111111-2222-4333-8444-555555555555', idToken: 'a.b.c' }, { headers }),
        await api.link((await proofFor(key, 'sign-in')).body, { headers }),
        await api.link((await proofFor(other, 'link')).body, { headers }),
        await api.link((await proofFor(key, 'link')).body, { headers: { ...headers, origin: 'https://evil.example', host: HUB_HOST } }),
        await call('POST', '/api/auth/did/link', { raw: 'a=b', headers: { ...headers, 'content-type': 'text/plain' } }),
        await api.link({}, { headers }),
        await api.unlink({ did: other.did }, { headers }),
        await api.unlink({ did: key.did }, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } }),
        await api.unlink({}, { headers }),
      ];

      expect(refusals.map((reply) => reply.status)).toEqual([400, 400, 409, 403, 415, 400, 404, 403, 400]);
      expect((await api.links({ headers })).status).toBe(200);
    });

    it('answers 401 on sign-in for every proof that does not hold, which is the answer the caller asked for', async () => {
      const key = newIdentity();
      await linkDid(1, key);

      const refused = await api.verify((await proofFor(key, 'sign-in', newIdentity())).body);

      expect(refused.status).toBe(401);
    });
  });
});
