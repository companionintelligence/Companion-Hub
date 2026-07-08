import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MemoryExchangeClient } from '../memory-exchange.client';
import { FORWARD_AUTH_SIGNATURE_HEADER, FORWARD_AUTH_TIMESTAMP_HEADER, FORWARD_AUTH_USER_HEADER } from '@/modules/auth/utils/forward-auth-signing';

vi.mock('axios');

/**
 * Unit tests for the server-to-server exchange client: it must sign every call
 * with the forward-auth headers, target the right CI-Server endpoints, surface
 * the exchanged key, and never let a revoke failure propagate.
 */
function makeClient(secret: string | undefined) {
  const config = { get: vi.fn().mockReturnValue(secret) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const client = new MemoryExchangeClient(config as never, logger as never);
  return { client, logger };
}

describe('MemoryExchangeClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchange posts the code to /api/connect/exchange with signed headers and returns the key', async () => {
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { appUrn: 'ci-openclaw:local', key: 'raw-key' } });

    const result = await client.exchange('http://gateway:8642/', 'the-code');

    expect(result).toEqual({ appUrn: 'ci-openclaw:local', key: 'raw-key' });
    const [url, body, opts] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://gateway:8642/api/connect/exchange'); // trailing slash trimmed
    expect(body).toEqual({ code: 'the-code' });
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers[FORWARD_AUTH_USER_HEADER]).toBe('ci-hub');
    expect(headers[FORWARD_AUTH_TIMESTAMP_HEADER]).toBeTruthy();
    expect(headers[FORWARD_AUTH_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exchange throws when no shared secret is configured', async () => {
    const { client } = makeClient(undefined);

    await expect(client.exchange('http://gateway:8642', 'code')).rejects.toThrow(/shared secret/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('revoke posts the app urn and is best-effort (never throws on transport failure)', async () => {
    const { client, logger } = makeClient('shared-secret');
    vi.mocked(axios.post).mockRejectedValue(new Error('connection refused'));

    await expect(client.revoke('http://gateway:8642', 'ci-openclaw:local')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('revoke targets /api/connect/revoke with the app urn', async () => {
    const { client } = makeClient('shared-secret');
    vi.mocked(axios.post).mockResolvedValue({ data: { revoked: 1 } });

    await client.revoke('http://gateway:8642', 'ci-openclaw:local');

    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('http://gateway:8642/api/connect/revoke');
    expect(body).toEqual({ app: 'ci-openclaw:local' });
  });
});
