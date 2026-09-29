import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppContext } from '@/context/app-context';
import { useDnsAvailability } from '@/modules/app/components/install-form/use-dns-availability';
import PortExposeCreatePage from './port-expose-create-page';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/context/app-context', () => ({ useAppContext: vi.fn() }));

const DOMAINS = {
  supported: true,
  domains: [] as Array<{ id: string; domain: string; isDefault: boolean; offered?: boolean }>,
};

/** Whether the domain list is still on its first load. */
const DOMAIN_LIST = { isLoading: false };

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: DOMAINS, isLoading: DOMAIN_LIST.isLoading, isFetching: false, isError: false, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getDomainsOptions: () => ({ queryKey: ['getDomains'] }),
}));

/*
 * Under jsdom, Radix's hidden native select answers a value the form sets with
 * its first option, so the real picker would overwrite what is under test. The
 * domain the form checks is the domain it would submit, so the check's input
 * is read instead.
 */
vi.mock('@/modules/app/components/install-form/cloudflare-subdomain-field', () => ({
  CloudflareSubdomainField: () => null,
}));

vi.mock('@/modules/app/components/install-form/use-dns-availability', () => ({
  useDnsAvailability: vi.fn(() => ({ isCheckingDns: false, dnsAvailabilityError: undefined, domainAvailabilityError: undefined })),
}));

const HUB_DOMAIN = 'companionintelligence.com';

const checkedDomain = () => vi.mocked(useDnsAvailability).mock.lastCall?.[0].selectedDomain;
const checkEnabled = () => vi.mocked(useDnsAvailability).mock.lastCall?.[0].enabled;

function renderPage() {
  vi.mocked(useAppContext).mockReturnValue({
    userSettings: { ciHubOrganizationSlug: 'acme', ciHubDeviceSlug: 'dev', domain: HUB_DOMAIN },
    cloudflareAvailable: true,
    tailscaleAvailable: false,
  } as unknown as ReturnType<typeof useAppContext>);

  return render(
    <MemoryRouter>
      <PortExposeCreatePage />
    </MemoryRouter>,
  );
}

describe('PortExposeCreatePage', () => {
  afterEach(() => {
    DOMAINS.domains = [];
    DOMAIN_LIST.isLoading = false;
    vi.clearAllMocks();
  });

  it('puts a new app on the domain Companion Portal preselects, not the Hub zone', async () => {
    DOMAINS.domains = [
      { id: '1', domain: HUB_DOMAIN, isDefault: false, offered: false },
      { id: '2', domain: 'ci1.pw', isDefault: true, offered: true },
    ];

    renderPage();

    await waitFor(() => expect(checkedDomain()).toBe('ci1.pw'));
  });

  /*
   * Until the list loads, the form holds the Hub zone. A Hub on a Portal zone (`ci.computer`) is
   * refused new names there, so checking it reported a domain the form was about to leave.
   */
  it('does not check availability until the domain list has loaded', async () => {
    DOMAIN_LIST.isLoading = true;

    const { rerender } = renderPage();

    await waitFor(() => expect(useDnsAvailability).toHaveBeenCalled());
    expect(vi.mocked(useDnsAvailability).mock.calls.every(([params]) => params.enabled === false)).toBe(true);

    DOMAIN_LIST.isLoading = false;
    DOMAINS.domains = [{ id: '2', domain: 'ci1.pw', isDefault: true, offered: true }];
    rerender(
      <MemoryRouter>
        <PortExposeCreatePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(checkEnabled()).toBe(true));
    expect(checkedDomain()).toBe('ci1.pw');
  });

  it('keeps the Hub zone when the Portal preselects nothing', async () => {
    renderPage();

    await waitFor(() => expect(checkedDomain()).toBe(HUB_DOMAIN));
  });
});
