import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { checkDnsAvailability } from '@/api-client/sdk.gen';
import type { CheckDnsAvailabilityResponse } from '@/api-client/types.gen';
import { fetchDnsAvailability } from '@/lib/cloudflare-api';
import { useDnsAvailability } from './use-dns-availability';

/*
 * Mocked at the generated client rather than at `fetchDnsAvailability`, so each
 * answer crosses the same seam the Hub's JSON does. The install-form tests mock
 * `@/lib/cloudflare-api` wholesale and hand the hook a body directly.
 */
vi.mock('@/api-client/sdk.gen', () => ({
  checkDnsAvailability: vi.fn(),
  getDiagnostics2: vi.fn(),
  repair: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const ZONE_FULL = "We can't serve any more apps from this domain. Pick another domain name to host this app.";

/** The Hub's answer, as `GET /api/cloudflare/check-dns-availability` sends it. */
function hubAnswers(data: CheckDnsAvailabilityResponse) {
  vi.mocked(checkDnsAvailability).mockResolvedValue({ data, response: new Response(null, { status: 200 }) } as never);
}

/*
 * Stable across renders, as the forms' `useCallback`s are: the hook re-checks on
 * every change to its inputs, and a fresh function each render would restart the
 * check and wipe the answer it just set.
 */
const checkDns = (subdomain: string, selectedDomain?: string) => fetchDnsAvailability(subdomain, { domain: selectedDomain });
const t = (key: string) => key;

async function checkSubdomain() {
  const setError = vi.fn();
  const clearErrors = vi.fn();
  const { result } = renderHook(() =>
    useDnsAvailability({
      enabled: true,
      subdomain: 'n8n',
      selectedDomain: 'ci3.pw',
      checkDnsAvailability: checkDns,
      setError,
      clearErrors,
      t,
    }),
  );

  // Past the hook's 500 ms debounce.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });

  return { result, setError, clearErrors };
}

describe('useDnsAvailability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('puts a zone Portal cannot write on the domain picker, not the subdomain', async () => {
    hubAnswers({ available: false, reason: 'zone_unreachable', message: ZONE_FULL });

    const { result, setError, clearErrors } = await checkSubdomain();

    expect(setError).toHaveBeenCalledWith('publicDomain', { type: 'manual', message: ZONE_FULL });
    expect(setError).not.toHaveBeenCalledWith('localSubdomain', expect.anything());
    expect(clearErrors).toHaveBeenCalledWith('localSubdomain');
    expect(result.current.domainAvailabilityError).toBe(ZONE_FULL);
    expect(result.current.dnsAvailabilityError).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(ZONE_FULL);
  });

  it('asks for another domain in its own words when Portal names the zone but sends no message', async () => {
    hubAnswers({ available: false, reason: 'zone_unreachable' });

    const { setError } = await checkSubdomain();

    expect(setError).toHaveBeenCalledWith('publicDomain', { type: 'manual', message: 'APP_INSTALL_FORM_ERROR_DOMAIN_UNAVAILABLE' });
  });

  it.each([
    ['a taken hostname', { available: false, reason: 'hostname_taken', message: 'DNS record already exists for n8n-core-2-acme.ci3.pw' }],
    [
      'an answer with no reason, as a Portal older than #846 sends',
      { available: false, message: 'DNS record already exists for n8n-core-2-acme.ci3.pw' },
    ],
  ] satisfies Array<[string, CheckDnsAvailabilityResponse]>)('keeps %s on the subdomain', async (_label, answer) => {
    hubAnswers(answer);

    const { result, setError, clearErrors } = await checkSubdomain();

    expect(setError).toHaveBeenCalledWith('localSubdomain', { type: 'manual', message: answer.message });
    expect(setError).not.toHaveBeenCalledWith('publicDomain', expect.anything());
    expect(clearErrors).toHaveBeenCalledWith('publicDomain');
    expect(result.current.dnsAvailabilityError).toBe(answer.message);
    expect(result.current.domainAvailabilityError).toBeNull();
  });

  /*
   * A form opens on the Hub's own domain and moves to Portal's preselection a
   * moment later. For a Hub on `ci.computer`, the first check is refused (a
   * Portal zone takes no new names) — and that refusal used to land on the
   * domain the form had moved to, whenever it came back last.
   */
  describe('when the domain changes while a check is in flight', () => {
    const answer = (data: CheckDnsAvailabilityResponse) => ({ ok: true, status: 200, json: async () => data });

    function renderOnHubDomain() {
      let refuseHubDomain!: () => void;
      const check = vi.fn((_subdomain: string, selectedDomain?: string) =>
        selectedDomain === 'ci.computer'
          ? new Promise<ReturnType<typeof answer>>((resolve) => {
              refuseHubDomain = () => resolve(answer({ available: false, reason: 'zone_unreachable', message: ZONE_FULL }));
            })
          : Promise.resolve(answer({ available: true })),
      );
      const setError = vi.fn();
      const clearErrors = vi.fn();
      const hook = renderHook(
        ({ selectedDomain }: { selectedDomain: string }) =>
          useDnsAvailability({ enabled: true, subdomain: 'n8n', selectedDomain, checkDnsAvailability: check, setError, clearErrors, t }),
        { initialProps: { selectedDomain: 'ci.computer' } },
      );

      return { ...hook, check, setError, refuseHubDomain: () => refuseHubDomain() };
    }

    it("drops the Hub domain's refusal when it arrives after the preselected domain's answer", async () => {
      const { result, rerender, check, setError, refuseHubDomain } = renderOnHubDomain();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(check).toHaveBeenCalledWith('n8n', 'ci.computer');

      rerender({ selectedDomain: 'ci0.pw' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(check).toHaveBeenLastCalledWith('n8n', 'ci0.pw');

      await act(async () => {
        refuseHubDomain();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(setError).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(result.current.domainAvailabilityError).toBeNull();
      expect(result.current.isCheckingDns).toBe(false);
    });

    it('keeps showing the check as running until the current one answers', async () => {
      const { result, rerender, refuseHubDomain } = renderOnHubDomain();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      rerender({ selectedDomain: 'ci0.pw' });

      // The stale answer lands inside the new check's debounce.
      await act(async () => {
        refuseHubDomain();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.isCheckingDns).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(result.current.isCheckingDns).toBe(false);
    });
  });

  /*
   * The forms key on `reason`, so it has to be in the generated client's type.
   * It was `{ [key: string]: unknown }`, which let #1627 read a field the Hub
   * never sent without a compile error. `pnpm tsc` enforces this, not vitest.
   */
  it('reads reason from the API contract', () => {
    expectTypeOf<CheckDnsAvailabilityResponse['reason']>().toEqualTypeOf<'zone_unreachable' | 'hostname_taken' | undefined>();
  });
});
