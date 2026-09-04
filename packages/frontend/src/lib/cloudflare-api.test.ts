import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TranslatableError } from '@/types/error.types';

/*
 * These cover the seam the install-form tests cannot reach: those mock
 * `@/lib/cloudflare-api` wholesale, so the mapping from an SDK result to a thrown
 * error is never executed there. The generated client RESOLVES on a non-2xx unless
 * `throwOnError` is passed, so the response interceptor's TranslatableError arrives
 * as `result.error` — dropping it is what turns a denied grant into "check the Hub
 * logs" for a fault that is not there.
 */
const { repair } = vi.hoisted(() => ({ repair: vi.fn() }));

vi.mock('@/api-client/sdk.gen', () => ({
  repair,
  checkDnsAvailability: vi.fn(),
  getDiagnostics2: vi.fn(),
}));

const { repairPublicWebRouting } = await import('./cloudflare-api');

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
const failed = (status: number, error: unknown) => ({ error, response: new Response(null, { status }) });

describe('repairPublicWebRouting', () => {
  beforeEach(() => {
    repair.mockReset();
  });

  it('sends the one app it was asked for and returns its results', async () => {
    repair.mockResolvedValue(ok({ results: [{ appUrn: 'n8n:store', success: true }], synced: true }));

    await expect(repairPublicWebRouting('n8n:store')).resolves.toEqual([{ appUrn: 'n8n:store', success: true }]);
    expect(repair).toHaveBeenCalledWith({ body: { appUrns: ['n8n:store'] } });
  });

  it('rethrows the denied-grant reason instead of the generic message', async () => {
    repair.mockResolvedValue(failed(403, new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'configure', app: 'n8n' })));

    await expect(repairPublicWebRouting('n8n:store')).rejects.toThrow('APP_ACTION_GRANT_DENIED');
  });

  it('falls back to the generic key when the failure carries no error of its own', async () => {
    repair.mockResolvedValue({ response: new Response(null, { status: 502 }) });

    await expect(repairPublicWebRouting('n8n:store')).rejects.toThrow('APP_PUBLIC_WEB_REPAIR_ERROR');
  });

  it('returns an empty list when the Hub found nothing to repair', async () => {
    repair.mockResolvedValue(ok({ results: [], synced: false }));

    await expect(repairPublicWebRouting('n8n:store')).resolves.toEqual([]);
  });

  it('returns an empty list rather than throwing when the body is not the expected shape', async () => {
    repair.mockResolvedValue(ok(undefined));

    await expect(repairPublicWebRouting('n8n:store')).resolves.toEqual([]);
  });
});
