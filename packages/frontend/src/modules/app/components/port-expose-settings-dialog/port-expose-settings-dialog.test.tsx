import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppContext } from '@/context/app-context';
import { useDnsAvailability } from '@/modules/app/components/install-form/use-dns-availability';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { PortExposeSettingsDialog } from './port-expose-settings-dialog';

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

/*
 * The Hub is `hub-hanz-hanz-corp.ci.computer`. Companion Portal lists `ci.computer` only as the Hub's
 * current zone, not offered: a Portal zone takes no new names.
 */
const PORTAL_LIST = {
  supported: true,
  domains: [
    { id: 'ci0', domain: 'ci0.pw', isDefault: true, offered: true },
    { id: 'current-ci.computer', domain: 'ci.computer', isDefault: false, offered: false },
  ],
};
const DOMAIN_LIST = { state: 'loaded' as 'loaded' | 'loading' | 'failed' };

vi.mock('@tanstack/react-query', () => ({
  useQuery: () =>
    DOMAIN_LIST.state === 'loading'
      ? { data: undefined, isLoading: true, isFetching: true, isError: false, refetch: vi.fn() }
      : DOMAIN_LIST.state === 'failed'
        ? { data: { supported: false, domains: [] }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }
        : { data: PORTAL_LIST, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() },
  useMutation: (options: { mutationFn: (body: unknown) => unknown }) => ({ mutate: (body: unknown) => saved(body), isPending: false, options }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const saved = vi.fn();

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getDomainsOptions: () => ({ queryKey: ['getDomains'] }),
  getAppQueryKey: () => ['getApp'],
}));

vi.mock('@/api-client/client.gen', () => ({ client: { patch: vi.fn() } }));

/*
 * Under jsdom, Radix's hidden native select answers a value the form sets with its first option, so
 * the real picker would overwrite what is under test. The domain the dialog checks is the domain it
 * would save, so the check's input is read instead, and the field's own tests cover the picker.
 */
vi.mock('@/modules/app/components/install-form/cloudflare-subdomain-field', () => ({
  CloudflareSubdomainField: ({ availableDomains, shownDomain }: { availableDomains: Array<{ domain: string }>; shownDomain?: string }) => (
    <div data-testid="domain-field" data-shown={shownDomain ?? ''} data-listed={availableDomains.map((entry) => entry.domain).join(',')} />
  ),
}));

vi.mock('@/modules/app/components/install-form/use-dns-availability', () => ({
  useDnsAvailability: vi.fn(() => ({ isCheckingDns: false, dnsAvailabilityError: undefined, domainAvailabilityError: undefined })),
}));

const lastCheck = () => vi.mocked(useDnsAvailability).mock.lastCall?.[0];
const field = () => screen.getByTestId('domain-field');

function renderDialog(app: Partial<AppDetails>) {
  vi.mocked(useAppContext).mockReturnValue({
    userSettings: { ciHubOrganizationSlug: 'hanz-corp', ciHubDeviceSlug: 'hanz', domain: 'ci.computer' },
    cloudflareAvailable: true,
    tailscaleAvailable: false,
  } as unknown as ReturnType<typeof useAppContext>);

  return render(
    <MemoryRouter>
      <PortExposeSettingsDialog
        app={{ port: 3000, localSubdomain: 'grafana', ...app } as AppDetails}
        info={{ id: 'grafana', urn: 'grafana:custom', port: 3000 } as unknown as AppInfo}
        isOpen
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
}

const moveToWeb = () => fireEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE' }));

describe('PortExposeSettingsDialog', () => {
  afterEach(() => {
    DOMAIN_LIST.state = 'loaded';
    vi.clearAllMocks();
  });

  it("moves an app to the Web on the domain Companion Portal preselects, never the Hub's own", async () => {
    renderDialog({ exposureMode: 'local' });

    moveToWeb();

    await waitFor(() => expect(lastCheck()).toMatchObject({ enabled: true, selectedDomain: 'ci0.pw' }));
    expect(field()).toHaveAttribute('data-shown', 'ci0.pw');
    expect(field()).toHaveAttribute('data-listed', 'ci0.pw');
    expect(vi.mocked(useDnsAvailability).mock.calls.some(([params]) => params.selectedDomain === 'ci.computer')).toBe(false);
  });

  it('shows and checks no domain while the list is loading', async () => {
    DOMAIN_LIST.state = 'loading';
    renderDialog({ exposureMode: 'local' });

    moveToWeb();

    await waitFor(() => expect(field()).toBeInTheDocument());
    expect(field()).toHaveAttribute('data-shown', '');
    expect(lastCheck()).toMatchObject({ enabled: false, selectedDomain: undefined });
  });

  it('saves no domain when the list cannot be loaded, so Companion Portal places the app', async () => {
    DOMAIN_LIST.state = 'failed';
    renderDialog({ exposureMode: 'local' });

    moveToWeb();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'COMMON_SAVE' }));
    });

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0]?.[0]).toMatchObject({ exposureMode: 'cloudflare', publicDomain: undefined });
    expect(vi.mocked(useDnsAvailability).mock.calls.every(([params]) => params.enabled === false)).toBe(true);
  });

  it('keeps an app already served on ci.computer there, and lists it', async () => {
    renderDialog({ exposureMode: 'cloudflare', publicDomain: 'ci.computer' });

    await waitFor(() => expect(lastCheck()).toMatchObject({ enabled: true, selectedDomain: 'ci.computer' }));
    expect(field()).toHaveAttribute('data-shown', 'ci.computer');
    expect(field()).toHaveAttribute('data-listed', 'ci0.pw,ci.computer');
  });
});
