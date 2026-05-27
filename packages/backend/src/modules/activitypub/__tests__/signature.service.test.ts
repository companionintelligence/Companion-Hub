import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignatureService } from '../signature.service';

describe('SignatureService', () => {
  let service: SignatureService;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    service = new SignatureService();
  });

  it('signs requests with digest and signature headers', () => {
    const headers = service.createSignedHeaders({
      url: 'https://remote.example/inbox',
      body: '{"hello":"world"}',
      keyId: 'https://hub.example.com/api/activitypub/actor#main-key',
      privateKeyPem: privateKey,
    });

    expect(headers.Digest).toMatch(/^SHA-256=/);
    expect(headers.Signature).toContain('keyId=');
  });

  it('verifies signed incoming requests against the fetched actor key', async () => {
    vi.spyOn(service, 'fetchRemoteActor').mockResolvedValue({
      publicKey: {
        publicKeyPem: publicKey,
      },
    });

    const body = '{"type":"Follow","actor":"https://remote.example/users/alice"}';
    const headers = service.createSignedHeaders({
      url: 'https://hub.example.com/api/activitypub/inbox',
      body,
      keyId: 'https://remote.example/users/alice#main-key',
      privateKeyPem: privateKey,
    });

    const request = {
      method: 'POST',
      originalUrl: '/api/activitypub/inbox',
      get: (name: string) => {
        const map: Record<string, string> = {
          signature: headers.Signature,
          date: headers.Date,
          digest: headers.Digest,
          host: 'hub.example.com',
          'content-type': headers['Content-Type'],
        };
        return map[name.toLowerCase()] || map[name] || '';
      },
    } as any;

    await expect(
      service.verifyIncomingRequest({
        request,
        body,
        actorUri: 'https://remote.example/users/alice',
      }),
    ).resolves.toBe(true);
  });
});
