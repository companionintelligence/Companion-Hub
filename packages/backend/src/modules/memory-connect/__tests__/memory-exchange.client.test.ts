import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MemoryExchangeClient } from '../memory-exchange.client';
import {
  buildConnectMessage,
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
} from '@/modules/auth/utils/connect-request-signing';

vi.mock('axios');

/**
 * Unit tests for the server-to-server exchange client: every call must be
 * signed with the replay-resistant connect headers, target the right CI-Server
 * endpoint, surface the key, and (for revoke/liveness) fail safe.
 */
function makeClient(secret: string | undefined) {
  const config = { get: vi.fn().mockReturnValue(secret) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const client = new MemoryExchangeClient(config as never, logger as never);
  return { client, logger };
}

function expectSigned(opts: { headers: Record<string, string> }) {
  expect(opts.headers[CONNECT_TIMESTAMP_HEADER]).toBeTruthy();
  expect(opts.headers[CONNECT_NONCE_HEADER]).toMatch(/^[0-9a-f]{32}$/);
  expect(opts.headers[CONNECT_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
}

describe('MemoryExchangeClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchange posts to /api/connect/exchange with signed headers and returns the key', async () => {
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' } });

    const result = await client.exchange('http://gateway:8642/', 'the-code');

    expect(result).toEqual({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    const [url, body, opts] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://gateway:8642/api/connect/exchange');
    expect(body).toEqual({ code: 'the-code' });
    expectSigned(opts as { headers: Record<string, string> });
  });

  it('signs the server-relative path (post-gateway, no /api) even though it POSTs to /api/...', async () => {
    // Regression: CI-Server is behind an nginx gateway that strips `/api` and has
    // no global route prefix, so its guard verifies the signature over
    // `/connect/exchange`. Signing `/api/connect/exchange` (the URL path) makes
    // every exchange/revoke/rotate 401. The URL keeps `/api`; the signature must not.
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { appUrn: 'ci-openclaw:local', key: 'raw-key' } });

    await client.exchange('http://gateway:8642', 'the-code');

    const [url, body, opts] = vi.mocked(axios.post).mock.calls[0];
    const headers = (opts as { headers: Record<string, string> }).headers;
    const ts = Number(headers[CONNECT_TIMESTAMP_HEADER]);
    const nonce = headers[CONNECT_NONCE_HEADER];
    const expected = crypto
      .createHmac('sha256', 'shared-secret')
      .update(buildConnectMessage('POST', '/connect/exchange', ts, nonce, body))
      .digest('hex');

    expect(url).toBe('http://gateway:8642/api/connect/exchange');
    expect(headers[CONNECT_SIGNATURE_HEADER]).toBe(expected);
  });

  it('rotate posts to /api/connect/rotate and returns the new key', async () => {
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { appUrn: 'ci-openclaw:local', key: 'new-key', expiresAt: '2026-10-07T00:00:00.000Z' } });

    const result = await client.rotate('http://gateway:8642', 'ci-openclaw:local');

    expect(result).toEqual({ appUrn: 'ci-openclaw:local', key: 'new-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://gateway:8642/api/connect/rotate');
    expect(body).toEqual({ app: 'ci-openclaw:local' });
  });

  it('exchange throws when no shared secret is configured', async () => {
    const { client } = makeClient(undefined);

    await expect(client.exchange('http://gateway:8642', 'code')).rejects.toThrow(/shared secret/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('revoke posts the app urn and returns false (never throws) on transport failure', async () => {
    const { client, logger } = makeClient('shared-secret');
    vi.mocked(axios.post).mockRejectedValue(new Error('connection refused'));

    await expect(client.revoke('http://gateway:8642', 'ci-openclaw:local')).resolves.toBe(false);
    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://gateway:8642/api/connect/revoke');
    expect(body).toEqual({ app: 'ci-openclaw:local' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('revoke returns true when CI-Server confirms the revocation', async () => {
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { revoked: 1 } });

    await expect(client.revoke('http://gateway:8642', 'ci-openclaw:local')).resolves.toBe(true);
  });

  describe('isKeyValid', () => {
    it('returns true on a 2xx response', async () => {
      const { client } = makeClient('shared-secret');
      vi.mocked(axios.get).mockResolvedValue({ data: { block: '' } });
      expect(await client.isKeyValid('http://gateway:8642', 'tok')).toBe(true);
    });

    it('returns false on a 401 (key invalidated / ci-memory reset)', async () => {
      const { client } = makeClient('shared-secret');
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      vi.mocked(axios.get).mockRejectedValue({ response: { status: 401 } });
      expect(await client.isKeyValid('http://gateway:8642', 'tok')).toBe(false);
    });

    it('returns true (fails safe) on a transient non-401 error', async () => {
      const { client } = makeClient('shared-secret');
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      vi.mocked(axios.get).mockRejectedValue({ response: { status: 503 } });
      expect(await client.isKeyValid('http://gateway:8642', 'tok')).toBe(true);
    });
  });
});
