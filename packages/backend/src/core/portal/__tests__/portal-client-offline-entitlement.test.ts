import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import * as crypto from 'node:crypto';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  PortalClientService,
  createOfflineEntitlementToken,
  parseEd25519PrivateKey,
  DEFAULT_OFFLINE_ENTITLEMENT_GRACE_MS,
} from '../portal-client.service';

describe('PortalClientService - Offline Entitlement Verification', () => {
  let portalClient: PortalClientService;
  let configuration: ReturnType<typeof mock<ConfigurationService>>;
  let keyPair: crypto.KeyPairSyncResult<string, string>;
  let publicKeyPem: string;
  let privateKeyPem: string;
  let rawPubHex: string;
  let rawPubB64: string;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
    configuration.get.mockReturnValue(undefined);

    // Generate fresh Ed25519 key pair for tests
    keyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeyPem = keyPair.publicKey;
    privateKeyPem = keyPair.privateKey;

    const keyObj = crypto.createPublicKey(publicKeyPem);
    const der = keyObj.export({ type: 'spki', format: 'der' });
    const rawPub = der.subarray(12);
    rawPubHex = rawPub.toString('hex');
    rawPubB64 = rawPub.toString('base64');

    portalClient = new PortalClientService(configuration);
  });

  it('verifies a valid Ed25519 offline entitlement token (JWT format)', () => {
    const now = Date.now();
    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/photoprism',
        entitled: true,
        exp: Math.floor(now / 1000) + 3600, // 1 hr in future
      },
      privateKeyPem,
    );

    const result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: publicKeyPem,
      expectedAppId: 'ci-marketplace/photoprism',
      currentTime: now,
    });

    expect(result.valid).toBe(true);
    expect(result.entitled).toBe(true);
    expect(result.inGracePeriod).toBe(false);
    expect(result.reason).toBe('valid');
    expect(result.payload?.appId).toBe('ci-marketplace/photoprism');
  });

  it('permits token within the grace period', () => {
    const now = Date.now();
    const expiredOneDayAgo = now - 24 * 60 * 60 * 1000;

    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/ollama',
        entitled: true,
        exp: Math.floor(expiredOneDayAgo / 1000),
      },
      privateKeyPem,
    );

    const result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: publicKeyPem,
      gracePeriodMs: DEFAULT_OFFLINE_ENTITLEMENT_GRACE_MS, // 7 days
      currentTime: now,
    });

    expect(result.valid).toBe(true);
    expect(result.entitled).toBe(true);
    expect(result.inGracePeriod).toBe(true);
    expect(result.reason).toBe('grace_period');
    expect(result.expiresAt).toBeDefined();
    expect(result.graceExpiresAt).toBeDefined();
  });

  it('rejects token expired beyond the grace period', () => {
    const now = Date.now();
    const expiredTenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/ollama',
        entitled: true,
        exp: Math.floor(expiredTenDaysAgo / 1000),
      },
      privateKeyPem,
    );

    const result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: publicKeyPem,
      gracePeriodMs: DEFAULT_OFFLINE_ENTITLEMENT_GRACE_MS, // 7 days
      currentTime: now,
    });

    expect(result.valid).toBe(false);
    expect(result.entitled).toBe(false);
    expect(result.inGracePeriod).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.error).toContain('grace period ended');
  });

  it('verifies using raw 32-byte hex and base64 public keys', () => {
    const now = Date.now();
    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/nextcloud',
        entitled: true,
        exp: Math.floor(now / 1000) + 1800,
      },
      privateKeyPem,
    );

    // Verify with hex key
    const hexResult = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: rawPubHex,
      currentTime: now,
    });
    expect(hexResult.valid).toBe(true);
    expect(hexResult.entitled).toBe(true);

    // Verify with base64 key
    const b64Result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: rawPubB64,
      currentTime: now,
    });
    expect(b64Result.valid).toBe(true);
    expect(b64Result.entitled).toBe(true);
  });

  it('rejects signature when signed with a different private key', () => {
    const wrongKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/photoprism',
        entitled: true,
      },
      wrongKeyPair.privateKey,
    );

    const result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: publicKeyPem,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects tampered token content', () => {
    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/photoprism',
        entitled: true,
      },
      privateKeyPem,
    );

    // Tamper with payload segment
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ appId: 'ci-marketplace/photoprism', entitled: true, extra: 1 })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const result = portalClient.verifyOfflineEntitlementToken(tamperedToken, {
      publicKey: publicKeyPem,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects when expected appId does not match', () => {
    const token = createOfflineEntitlementToken(
      {
        appId: 'ci-marketplace/plex',
        entitled: true,
      },
      privateKeyPem,
    );

    const result = portalClient.verifyOfflineEntitlementToken(token, {
      publicKey: publicKeyPem,
      expectedAppId: 'ci-marketplace/jellyfin',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('app_mismatch');
  });

  it('verifies 2-segment and object token formats', () => {
    const payload = {
      appId: 'ci-marketplace/photoprism',
      entitled: true,
    };
    const payloadStr = JSON.stringify(payload);
    const sig = crypto.sign(null, Buffer.from(payloadStr, 'utf8'), parseEd25519PrivateKey(privateKeyPem));

    // Object format
    const objResult = portalClient.verifyOfflineEntitlementToken({ payload, signature: sig.toString('base64') }, { publicKey: publicKeyPem });
    expect(objResult.valid).toBe(true);

    // 2-segment format (b64url(payload).b64url(sig))
    const b64Payload = Buffer.from(payloadStr, 'utf8').toString('base64url');
    const b64Sig = sig.toString('base64url');
    const twoSegResult = portalClient.verifyOfflineEntitlementToken(`${b64Payload}.${b64Sig}`, { publicKey: publicKeyPem });
    expect(twoSegResult.valid).toBe(true);
  });

  it('reports missing public key if none configured or provided', () => {
    const token = createOfflineEntitlementToken({ appId: 'ci-marketplace/photoprism' }, privateKeyPem);

    const result = portalClient.verifyOfflineEntitlementToken(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_public_key');
  });
});
