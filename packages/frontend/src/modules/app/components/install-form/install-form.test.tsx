import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { useForm } from 'react-hook-form';
import type { AppInfo, FormField } from '@/types/app.types';
import { CustomDomainField } from './custom-domain-field';
import { InstallForm } from './install-form';
import { useAppContext } from '@/context/app-context';
import { TranslatableError } from '@/types/error.types';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

// Mocks
vi.mock('@/context/app-context', () => ({
  useAppContext: vi.fn(),
}));

const { fetchDnsAvailability, fetchPublicWebDiagnostics, repairPublicWebRouting } = vi.hoisted(() => ({
  fetchDnsAvailability: vi.fn(),
  fetchPublicWebDiagnostics: vi.fn().mockResolvedValue(null),
  repairPublicWebRouting: vi.fn(),
}));

vi.mock('@/lib/cloudflare-api', async (importOriginal) => ({
  // Spread the original so a constant the form imports (the shared diagnostics query
  // key) does not have to be restated here — a bare factory makes any new named
  // export a runtime "No export is defined on the mock" the moment it is used.
  ...(await importOriginal<typeof import('@/lib/cloudflare-api')>()),
  fetchDnsAvailability,
  fetchPublicWebDiagnostics,
  repairPublicWebRouting,
}));

const { mockTauriInvoke } = vi.hoisted(() => ({ mockTauriInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockTauriInvoke(...args),
}));

const { toast } = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: toast,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

/*
 * `@ci-hub/common/types` is NOT mocked. The picker's confirmation, its notes and
 * the Hub's bind pass all decide with the same shared predicates, and a copy here
 * would let the picker drift from the bind pass while these tests stayed green.
 */

const MOCK_AVAILABLE_DOMAINS = { domains: [] as Array<{ id: string; domain: string; isDefault: boolean; scope?: string }> };
/**
 * The organization's connected custom domains, as `GET /cloudflare/custom-domains`
 * reports them. `supported: false` is the default because it is the default
 * DEPLOYMENT: an older Companion Portal, or one that did not answer — and the picker must
 * render nothing there rather than an empty dropdown advertising the feature.
 */
const MOCK_CUSTOM_DOMAINS = {
  supported: false,
  domains: [] as Array<{
    id: string;
    domain: string;
    state: 'live' | 'parked' | 'pending' | 'securing' | 'drifted' | 'unknown';
    bindable: boolean;
    targetHostname: string | null;
    boundAppSlug: string | null;
    boundElsewhere: boolean;
  }>,
};
const MOCK_USE_QUERY_RESULT = {
  data: MOCK_AVAILABLE_DOMAINS,
  isLoading: false,
};
/** `GET /portal/config`. No portal address by default, as on a Hub with none configured. */
const MOCK_PORTAL_CONFIG = { portalUrl: null as string | null, deviceId: null, registrationUrl: null, demoMode: false };

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
  // Keyed, so the queries the form reads cannot answer each other's
  // question — a single shared result had the custom-domain picker reading the
  // platform domain list.
  useQuery: (options: { queryKey?: unknown[] }) => {
    if (options?.queryKey?.[0] === 'getCustomDomains') return { data: MOCK_CUSTOM_DOMAINS, isLoading: false };
    if (options?.queryKey?.[0] === 'getPortalConfig') return { data: MOCK_PORTAL_CONFIG, isLoading: false };
    return MOCK_USE_QUERY_RESULT;
  },
  // The form reaches for a client to refresh the Public Web report after a routing
  // repair. Nothing here repairs anything, so the mock only has to satisfy the hook.
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: (options: unknown) => options,
}));

// Mock API client if needed
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getRandomPortMutation: () => ({ mutationFn: vi.fn() }),
  getDomainsOptions: () => ({ queryKey: ['getDomains'], queryFn: vi.fn() }),
  getCustomDomainsOptions: () => ({ queryKey: ['getCustomDomains'], queryFn: vi.fn() }),
  getPortalConfigOptions: () => ({ queryKey: ['getPortalConfig'], queryFn: vi.fn() }),
}));

describe('InstallForm', () => {
  afterEach(() => {
    MOCK_AVAILABLE_DOMAINS.domains = [];
    MOCK_CUSTOM_DOMAINS.supported = false;
    MOCK_CUSTOM_DOMAINS.domains = [];
    MOCK_PORTAL_CONFIG.portalUrl = null;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createContext = (advancedMode: boolean) => ({
    userSettings: {
      ciHubOrganizationSlug: undefined,
      localDomain: 'ci.lan',
      domain: 'example.com',
      maxBackups: 5,
      guestDashboard: false,
    },
    user: { advancedMode },
    isProduction: true,
    cloudflareAvailable: true,
    tailscaleAvailable: false,
  });

  const baseInfo = {
    urn: 'app:store',
    form_fields: [],
    exposable: false,
    dynamic_config: false,
  } as unknown as AppInfo;

  it('should display organization slug in subdomain suffix when present', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'Josh', // Case insensitive check
        localDomain: 'ci.lan',
        domain: 'example.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'app:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    // Expect to see "-josh.example.com" (lowercased)
    expect(screen.getAllByText(/-josh.example.com/).length).toBeGreaterThan(0);
  });

  it('should fallback to public domain when organization slug is missing', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: undefined,
        localDomain: 'ci.lan',
        domain: 'example.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'app:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    // Expect to see "-example.com"
    expect(screen.getByText(/-example.com/)).toBeInTheDocument();
  });

  it('shows Network settings link when Private VPN exposure is unavailable', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: undefined,
        localDomain: 'ci.lan',
        domain: 'example.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: false },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'app:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'APP_INSTALL_FORM_EXPOSURE_TAILSCALE_SETUP_LINK' });
    expect(link).toHaveAttribute('href', '/settings?tab=network');
  });

  it('renders exposure mode buttons in local, private vpn, public order', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: false },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    const buttons = screen
      .getAllByRole('button')
      .filter((button) =>
        ['APP_INSTALL_FORM_EXPOSURE_LOCAL', 'COMMON_PRIVATE_VPN', 'APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE'].includes(button.textContent ?? ''),
      );

    expect(buttons.map((button) => button.textContent)).toEqual([
      'APP_INSTALL_FORM_EXPOSURE_LOCAL',
      'COMMON_PRIVATE_VPN',
      'APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE',
    ]);
  });

  it('shows advanced settings toggle in simple mode when optional fields exist', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(false) as unknown as ReturnType<typeof useAppContext>);

    const formFields = [
      {
        env_variable: 'REQUIRED_FIELD',
        label: 'Required field',
        type: 'text',
        required: true,
      },
      {
        env_variable: 'OPTIONAL_FIELD',
        label: 'Optional field',
        type: 'text',
        required: false,
      },
    ] as never[];

    render(
      <MemoryRouter>
        <InstallForm info={baseInfo} onSubmit={vi.fn()} formId="test-form" formFields={formFields} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('switch', { name: 'APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS' })).toBeInTheDocument();
    expect(screen.getByText('Required field')).toBeInTheDocument();
    expect(screen.queryByText('Optional field')).not.toBeInTheDocument();
  });

  it('reveals optional fields when advanced settings toggle is enabled in simple mode', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(false) as unknown as ReturnType<typeof useAppContext>);

    const formFields = [
      {
        env_variable: 'OPTIONAL_FIELD',
        label: 'Optional field',
        type: 'text',
        required: false,
      },
    ] as never[];

    render(
      <MemoryRouter>
        <InstallForm info={baseInfo} onSubmit={vi.fn()} formId="test-form" formFields={formFields} />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('switch', { name: 'APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS' });
    fireEvent.click(toggle);

    expect(screen.getByText('Optional field')).toBeInTheDocument();
  });

  it('surfaces the full hostname from the DNS availability response', async () => {
    vi.useFakeTimers();
    fetchDnsAvailability.mockResolvedValue(
      new Response(
        JSON.stringify({
          available: false,
          message: 'DNS record already exists for ci-openclaw-blaptop-bc.companionintelligence.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('DNS record already exists for ci-openclaw-blaptop-bc.companionintelligence.com')).toBeInTheDocument();
  });

  it('passes the current app urn when validating DNS inside the settings dialog flow', async () => {
    vi.useFakeTimers();
    fetchDnsAvailability.mockResolvedValue(
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} editingAppUrn="ci-openclaw:store" />
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchDnsAvailability).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ appUrn: 'ci-openclaw:store' }));
  });

  it('does not keep rechecking DNS availability after a successful response', async () => {
    vi.useFakeTimers();
    fetchDnsAvailability.mockResolvedValue(
      new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchDnsAvailability).toHaveBeenCalledTimes(1);
  });

  it('shows optional fields by default and hides toggle in advanced mode', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(true) as unknown as ReturnType<typeof useAppContext>);

    const formFields = [
      {
        env_variable: 'OPTIONAL_FIELD',
        label: 'Optional field',
        type: 'text',
        required: false,
      },
    ] as never[];

    render(
      <MemoryRouter>
        <InstallForm info={baseInfo} onSubmit={vi.fn()} formId="test-form" formFields={formFields} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('switch', { name: 'APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS' })).not.toBeInTheDocument();
    expect(screen.getByText('Optional field')).toBeInTheDocument();
  });

  it('does not run DNS availability checks for Private VPN exposure mode', async () => {
    vi.useFakeTimers();
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
      port: 3000,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} initialValues={{ exposureMode: 'tailscale' }} />
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
    });

    expect(fetchDnsAvailability).not.toHaveBeenCalled();
  });

  describe('custom domain picker', () => {
    const CONTEXT = {
      userSettings: {
        ciHubOrganizationSlug: 'acme',
        ciHubDeviceSlug: 'core2',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>;

    const INFO = {
      urn: 'comfyui:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
      port: 8188,
    } as unknown as AppInfo;

    const connected = (overrides: Record<string, unknown> = {}) => ({
      id: 'cd_1',
      domain: 'comfy.acme.com',
      state: 'parked' as const,
      bindable: true,
      targetHostname: null,
      boundAppSlug: null,
      boundElsewhere: false,
      ...overrides,
    });

    const renderForm = (initialValues: Record<string, unknown> = { exposureMode: 'cloudflare' }) => {
      vi.mocked(useAppContext).mockReturnValue(CONTEXT);

      return render(
        <MemoryRouter>
          <InstallForm info={INFO} onSubmit={vi.fn()} formId="test-form" formFields={[]} initialValues={initialValues} />
        </MemoryRouter>,
      );
    };

    it('renders nothing when CI-Cloud could not be asked', () => {
      /*
       * This is not an empty dropdown. An older Companion Portal, or one that did not answer,
       * must not have the Hub advertise a feature it cannot offer — and must not
       * be mistaken for "this organization owns no domains", which is a different
       * sentence with a different next step.
       */
      MOCK_CUSTOM_DOMAINS.supported = false;
      MOCK_CUSTOM_DOMAINS.domains = [connected()];

      renderForm();

      expect(screen.queryByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).not.toBeInTheDocument();
    });

    it('renders nothing when the organization owns no custom domains', () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [];

      renderForm();

      expect(screen.queryByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).not.toBeInTheDocument();
    });

    it('offers the organization connected domains under public exposure', () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected()];

      renderForm();

      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toBeInTheDocument();
      // Defaults to the platform address: a custom domain is a choice somebody
      // makes, never one the dialog makes for them.
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE');
    });

    it('does not offer a custom domain for an app that publishes no public route', () => {
      // A custom domain is delivered by cloning this app's tunnel ingress rule.
      // A local-only app has nothing for one to alias.
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected()];

      renderForm({ exposureMode: 'local' });

      expect(screen.queryByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).not.toBeInTheDocument();
    });

    it('offers a domain whose certificate is still issuing, and says so', () => {
      /*
       * Companion Portal reports `securing` as BINDABLE — Cloudflare gates ownership and
       * TLS independently, so a proved domain routinely has minutes of issuance
       * left, and it finishes on its own. Choosing it is fine; being surprised
       * by it afterwards is not.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'securing' })];

      renderForm();

      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toBeInTheDocument();
    });

    it('still offers a domain whose state this build has never heard of', () => {
      // A Hub is older than the Portal it talks to for most of its life. An
      // unrecognised state must not make a connected domain disappear.
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'unknown' })];

      renderForm();

      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toBeInTheDocument();
    });

    it('shows the domain a saved app was set up to use', () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected()];

      renderForm({ exposureMode: 'cloudflare', customDomain: 'comfy.acme.com' });

      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent('comfy.acme.com');
      // And says the restart out loud, rather than springing it after the install.
      expect(screen.getByText(/APP_INSTALL_FORM_CUSTOM_DOMAIN_PENDING_HINT/)).toBeInTheDocument();
    });

    it('shows the closed control the hostname alone, never an option status', () => {
      /*
       * The assertion is `toHaveTextContent(/^…$/)`, not a substring. Radix
       * portals an item's `ItemText` into the trigger, so a status put inside the
       * option followed it there and the collapsed control read
       * "comfy.acme.com — in use by comfyui" where every other select in the
       * dialog shows a short value. A substring assertion passes either way,
       * which is exactly how it shipped.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundAppSlug: 'wordpress' })];

      renderForm({ exposureMode: 'cloudflare', customDomain: 'comfy.acme.com' });

      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent(/^comfy\.acme\.com$/);
    });

    it("recognises the app's own domain when it has no Local Subdomain of its own", async () => {
      /*
       * ⚠ THE FALLBACKS HAVE TO MATCH. `resolveRoutingSubdomain` on the backend
       * falls back to `<appName>-<appStoreSlug>`, which is what the bind sends
       * and what CI-Cloud returns as `boundAppSlug`. The field's PLACEHOLDER is
       * the bare app name, and comparing that instead made every app installed
       * without a Local Subdomain — API, MCP and restore installs — read as
       * somebody else's: the picker asked the operator to confirm moving the
       * app's own domain away from itself.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundAppSlug: 'comfyui-store', targetHostname: 'comfyui-core2-acme.example.com' })];

      /*
       * `dynamic_config: false`, because that is what leaves `localSubdomain`
       * empty. The form auto-fills it for a dynamic-config app, and an app that
       * carries a subdomain has no fallback to get wrong — so this is the only
       * shape where the two fallbacks are compared against each other.
       */
      vi.mocked(useAppContext).mockReturnValue(CONTEXT);

      render(
        <MemoryRouter>
          <InstallForm
            info={{ ...INFO, dynamic_config: false } as unknown as AppInfo}
            onSubmit={vi.fn()}
            formId="test-form"
            formFields={[]}
            initialValues={{ exposureMode: 'cloudflare' }}
          />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      fireEvent.click(screen.getByRole('option', { name: /comfy\.acme\.com/ }));

      expect(screen.queryByTestId('custom-domain-takeover-confirm')).not.toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent(/^comfy\.acme\.com$/);
    });

    it('does not warn that a domain is in use by the app being configured', () => {
      /*
       * The normal case in the settings dialog. Telling the operator that
       * choosing this domain takes it away from `comfyui` — while they are
       * editing `comfyui` — warns about nothing and reads as a bug.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundAppSlug: 'comfyui' })];

      renderForm({ exposureMode: 'cloudflare', localSubdomain: 'comfyui', customDomain: 'comfy.acme.com' });

      expect(screen.queryByText(/APP_INSTALL_FORM_CUSTOM_DOMAIN_IN_USE/)).not.toBeInTheDocument();
    });

    it('names a permanently failed certificate instead of offering it silently', () => {
      /*
       * CI-Cloud reports `failed` with `bindable: true`, deliberately. A build
       * that had not heard of the state parsed it as `unknown`, matched none of
       * the picker's conditions, and rendered a domain whose certificate can
       * never issue as an ordinary choice with no note at all.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'failed' })];

      renderForm();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));

      expect(screen.getByText('APP_INSTALL_FORM_CUSTOM_DOMAIN_FAILED')).toBeInTheDocument();
    });

    it('asks before moving a domain no device holds any more, and commits nothing until answered', async () => {
      /*
       * CI-Engineering#208, defect 4. The domain was selectable with only a text
       * suffix, and a background heartbeat then moved a production hostname off
       * another device in the organization with no confirmation anywhere.
       *
       * `boundElsewhere` and still `bindable`: its Hub was deleted, so this Hub
       * may take it once somebody confirms. (A CI-Cloud from before CI-Portal#686
       * listed a domain live on a sibling Hub the same way.)
       *
       * ⚠ THE FORM MUST STILL HOLD THE PLATFORM ADDRESS while the question is
       * open. Writing the choice first and the answer second means a save
       * landing between the two records a move with no confirmation attached,
       * which the bind pass reads as a refusal — the operator's choice silently
       * dropped.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'live', boundElsewhere: true, bindable: true, targetHostname: 'grafana-core9-acme.example.com' }),
      ];

      renderForm();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      // By role, not by text: Radix mirrors an item's label into the trigger,
      // so a plain text query matches both the option and the collapsed control.
      fireEvent.click(screen.getByRole('option', { name: /comfy\.acme\.com/ }));

      expect(screen.getByTestId('custom-domain-takeover-confirm')).toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE');
      // Bindable, so a move this Hub can make itself: no errand to the portal for it.
      expect(screen.queryByTestId('custom-domain-held-elsewhere')).not.toBeInTheDocument();
    });

    it('leaves the domain where it is when the move is declined', async () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundElsewhere: true, targetHostname: 'grafana-core9-acme.example.com' })];

      renderForm();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      // By role, not by text: Radix mirrors an item's label into the trigger,
      // so a plain text query matches both the option and the collapsed control.
      fireEvent.click(screen.getByRole('option', { name: /comfy\.acme\.com/ }));
      fireEvent.click(screen.getByTestId('custom-domain-takeover-cancel'));

      expect(screen.queryByTestId('custom-domain-takeover-confirm')).not.toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE');
    });

    it('commits the choice once the move is confirmed', async () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundElsewhere: true, targetHostname: 'grafana-core9-acme.example.com' })];

      renderForm();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      // By role, not by text: Radix mirrors an item's label into the trigger,
      // so a plain text query matches both the option and the collapsed control.
      fireEvent.click(screen.getByRole('option', { name: /comfy\.acme\.com/ }));
      fireEvent.click(screen.getByTestId('custom-domain-takeover-accept'));

      expect(screen.queryByTestId('custom-domain-takeover-confirm')).not.toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent(/^comfy\.acme\.com$/);
    });

    it('does not ask when the domain is already serving the app being configured', () => {
      // Re-picking the domain an app already serves is not a move, and asking
      // about it would read as a bug in the ordinary settings case.
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundAppSlug: 'comfyui', targetHostname: 'comfyui-core2-acme.example.com' })];

      renderForm({ exposureMode: 'cloudflare', localSubdomain: 'comfyui' });

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      // By role, not by text: Radix mirrors an item's label into the trigger,
      // so a plain text query matches both the option and the collapsed control.
      fireEvent.click(screen.getByRole('option', { name: /comfy\.acme\.com/ }));

      expect(screen.queryByTestId('custom-domain-takeover-confirm')).not.toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent(/^comfy\.acme\.com$/);
    });

    it('warns that clearing the picker releases a domain the app is serving', () => {
      /*
       * CI-Cloud cannot park a connected domain, so this save gives it up
       * entirely and only a person in the portal can reconnect it. Showing that
       * behind the same neutral sentence used when nothing is bound would be the
       * one place this dialog hides an irreversible act.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected({ state: 'live', boundAppSlug: 'comfyui', targetHostname: 'comfyui-core2-acme.example.com' })];

      renderForm({ exposureMode: 'cloudflare', localSubdomain: 'comfyui' });

      expect(screen.getByText('APP_INSTALL_FORM_CUSTOM_DOMAIN_RELEASE_HINT')).toBeInTheDocument();
    });

    it('does not threaten a release when the app is not serving anything', () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [connected()];

      renderForm();

      expect(screen.getByText('APP_INSTALL_FORM_CUSTOM_DOMAIN_HINT')).toBeInTheDocument();
      expect(screen.queryByText('APP_INSTALL_FORM_CUSTOM_DOMAIN_RELEASE_HINT')).not.toBeInTheDocument();
    });

    it('disables a domain another Hub holds, and links to where it can be moved', () => {
      /*
       * CI-Cloud will not bind a domain another device holds, so choosing it here
       * could only be refused. The option used to say "currently serving another
       * app" and nothing more, which left the operator no idea where the move is
       * actually made.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'live', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
      ];
      // As `/api/portal/config` serves it: trimmed, with no trailing slash.
      MOCK_PORTAL_CONFIG.portalUrl = 'https://portal.example.com';

      renderForm();

      // Asked before the listbox opens: an open Radix select hides the rest of the dialog from role queries.
      const link = screen.getByRole('link', { name: 'APP_INSTALL_FORM_CUSTOM_DOMAIN_MOVE_IN_PORTAL' });
      expect(link).toHaveAttribute('href', 'https://portal.example.com/org-settings?tab=domains');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByTestId('custom-domain-held-elsewhere')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_ON_ANOTHER_HUB_HINT');

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));
      const option = screen.getByRole('option', { name: /comfy\.acme\.com/ });

      expect(option).toHaveAttribute('aria-disabled', 'true');
      expect(option).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_ON_ANOTHER_HUB');

      fireEvent.click(option);

      // Nothing to confirm, because no answer given on this Hub could move it.
      expect(screen.queryByTestId('custom-domain-takeover-confirm')).not.toBeInTheDocument();
      expect(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_NONE');
    });

    it('names the remedy without a link when this Hub has no portal address', () => {
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'live', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
      ];
      MOCK_PORTAL_CONFIG.portalUrl = null;

      renderForm();

      expect(screen.getByTestId('custom-domain-held-elsewhere')).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_MOVE_IN_PORTAL');
      expect(screen.queryByRole('link', { name: 'APP_INSTALL_FORM_CUSTOM_DOMAIN_MOVE_IN_PORTAL' })).not.toBeInTheDocument();
    });

    it('says a domain is on another Hub while its certificate is still issuing there', () => {
      // That certificate finishes on its own. What matters on this Hub is why the option cannot be chosen.
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'securing', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
      ];

      renderForm();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));

      expect(screen.getByRole('option', { name: /comfy\.acme\.com/ })).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_ON_ANOTHER_HUB');
      expect(screen.queryByText('APP_INSTALL_FORM_CUSTOM_DOMAIN_SECURING')).not.toBeInTheDocument();
    });

    it('says a domain is still verifying rather than on another Hub, while the listing cannot tell who holds it', () => {
      /*
       * Unverified is unbindable for every Hub, so `bindable: false` beside
       * `boundElsewhere` is also what a row whose Hub was deleted looks like.
       * Verification settles it; until then the portal is not the remedy.
       */
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'pending', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
      ];

      renderForm();

      expect(screen.queryByTestId('custom-domain-held-elsewhere')).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));

      expect(screen.getByRole('option', { name: /comfy\.acme\.com/ })).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_VERIFYING');
    });

    it('names a failed certificate on a domain another Hub holds, and does not send anyone to move it', () => {
      // Moving it would not issue the certificate; reconnecting the domain fixes both.
      MOCK_CUSTOM_DOMAINS.supported = true;
      MOCK_CUSTOM_DOMAINS.domains = [
        connected({ state: 'failed', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
      ];

      renderForm();

      expect(screen.queryByTestId('custom-domain-held-elsewhere')).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('APP_INSTALL_FORM_CUSTOM_DOMAIN'));

      expect(screen.getByRole('option', { name: /comfy\.acme\.com/ })).toHaveTextContent('APP_INSTALL_FORM_CUSTOM_DOMAIN_FAILED');
    });

    it('names the domains another Hub holds in the note, because it shows while the listbox is closed', () => {
      const domains = [
        connected({ state: 'live', boundElsewhere: true, bindable: false, targetHostname: 'grafana-core9-acme.example.com' }),
        connected({
          id: 'cd_2',
          domain: 'shop.acme.com',
          state: 'live',
          boundElsewhere: true,
          bindable: false,
          targetHostname: 'shop-core9-acme.example.com',
        }),
        connected({ id: 'cd_3', domain: 'parked.acme.com' }),
      ];
      // A `t` that shows its values, which the module-wide mock drops.
      const t = (key: string, values?: Record<string, string>) => (values ? `${key} ${Object.values(values).join(' ')}` : key);
      const Harness = () => {
        const { control } = useForm();

        return <CustomDomainField control={control} domains={domains as never} supported onTakeoverChange={vi.fn()} t={t} />;
      };

      render(<Harness />);

      expect(screen.getByTestId('custom-domain-held-elsewhere')).toHaveTextContent('comfy.acme.com, shop.acme.com');
      expect(screen.getByTestId('custom-domain-held-elsewhere')).not.toHaveTextContent('parked.acme.com');
    });
  });

  it('hides the subdomain field for Private VPN exposure mode', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
      port: 3000,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} initialValues={{ exposureMode: 'tailscale' }} />
      </MemoryRouter>,
    );

    expect(screen.queryByLabelText('APP_INSTALL_FORM_LOCAL_SUBDOMAIN')).not.toBeInTheDocument();
    expect(screen.getByText('COMMON_HOSTNAME')).toBeInTheDocument();
  });

  it('shows a localhost hostname preview for This machine only exposure mode', () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
      port: 3001,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} initialValues={{ exposureMode: 'local' }} />
      </MemoryRouter>,
    );

    expect(screen.getByText('COMMON_HOSTNAME')).toBeInTheDocument();
    expect(screen.getByText('localhost:3001')).toBeInTheDocument();
  });

  const appBaseUrlField = {
    env_variable: 'APP_BASE_URL',
    label: 'Public URL',
    type: 'app_base_url',
    required: true,
  } as never;

  const exposableContext = (overrides: Record<string, unknown> = {}) =>
    ({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: true },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: true,
      tailscaleNodeFqdn: 'hub-tailscale-1.example.ts.net',
      tailscaleHttpsEnabled: false,
      ...overrides,
    }) as unknown as ReturnType<typeof useAppContext>;

  const exposableInfo = (port = 3001) =>
    ({
      urn: 'n8n:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
      port,
    }) as unknown as AppInfo;

  const getAppBaseUrlInput = () => screen.getByLabelText(/Public URL/);

  it('prefills app_base_url for local exposure mode', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo(3001)}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[appBaseUrlField]}
          initialValues={{ exposureMode: 'local' }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('http://localhost:3001');
    });
  });

  it('prefills app_base_url for cloudflare exposure mode', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo()} onSubmit={vi.fn()} formId="test-form" formFields={[appBaseUrlField]} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('https://n8n-blaptop-bc.companionintelligence.com');
    });
  });

  it('prefills app_base_url for tailscale exposure mode', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo(3000)}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[appBaseUrlField]}
          initialValues={{ exposureMode: 'tailscale' }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('http://hub-tailscale-1.example.ts.net:3000');
    });
  });

  it('does not overwrite configured app_base_url initial values', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo()}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[appBaseUrlField]}
          initialValues={{ exposureMode: 'local', APP_BASE_URL: 'https://custom.example.com' }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('https://custom.example.com');
    });
  });

  it('does not overwrite user-edited app_base_url when exposure mode changes', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo(3001)}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[appBaseUrlField]}
          initialValues={{ exposureMode: 'local' }}
        />
      </MemoryRouter>,
    );

    const input = await waitFor(() => {
      const field = getAppBaseUrlInput();
      expect(field).toHaveValue('http://localhost:3001');
      return field;
    });

    fireEvent.change(input, { target: { value: 'https://user.example.com' } });

    fireEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_EXPOSURE_CLOUDFLARE' }));

    expect(input).toHaveValue('https://user.example.com');
  });

  it('updates auto-prefilled app_base_url when the cloudflare hostname preview changes', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo(3001)} onSubmit={vi.fn()} formId="test-form" formFields={[appBaseUrlField]} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('https://n8n-blaptop-bc.companionintelligence.com');
    });

    fireEvent.change(screen.getByLabelText(/APP_INSTALL_FORM_LOCAL_SUBDOMAIN/), { target: { value: 'wiki' } });

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('https://wiki-blaptop-bc.companionintelligence.com');
    });
  });

  it('does not show advanced settings toggle when there are no optional fields', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(false) as unknown as ReturnType<typeof useAppContext>);

    const formFields = [
      {
        env_variable: 'REQUIRED_FIELD',
        label: 'Required field',
        type: 'text',
        required: true,
      },
    ] as never[];

    render(
      <MemoryRouter>
        <InstallForm info={baseInfo} onSubmit={vi.fn()} formId="test-form" formFields={formFields} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('switch', { name: 'APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS' })).not.toBeInTheDocument();
    expect(screen.getByText('Required field')).toBeInTheDocument();
  });

  it('shows advanced settings toggle for exposable apps without optional fields in simple mode', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(false) as unknown as ReturnType<typeof useAppContext>);

    const exposableInfo = {
      ...baseInfo,
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    const formFields = [
      {
        env_variable: 'REQUIRED_FIELD',
        label: 'Required field',
        type: 'text',
        required: true,
      },
    ] as never[];

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo} onSubmit={vi.fn()} formId="test-form" formFields={formFields} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('switch', { name: 'APP_INSTALL_FORM_SHOW_ADVANCED_SETTINGS' })).toBeInTheDocument();
  });

  it('renders the public domain selector inside the subdomain field in simple mode', () => {
    vi.mocked(useAppContext).mockReturnValue(createContext(false) as unknown as ReturnType<typeof useAppContext>);
    MOCK_AVAILABLE_DOMAINS.domains = [{ id: 'd1', domain: 'ci.computer', isDefault: true }];

    const exposableInfo = {
      ...baseInfo,
      exposable: true,
      dynamic_config: true,
      urn: 'activepieces:gitstore',
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('COMMON_PUBLIC_DOMAIN')).toBeInTheDocument();

    MOCK_AVAILABLE_DOMAINS.domains = [];
    MOCK_CUSTOM_DOMAINS.supported = false;
    MOCK_CUSTOM_DOMAINS.domains = [];
  });

  it('shows hostname details with copy buttons in simple mode', async () => {
    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: false },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);
    MOCK_AVAILABLE_DOMAINS.domains = [{ id: 'd1', domain: 'companionintelligence.com', isDefault: true }];

    const mockInfo = {
      urn: 'ci-openclaw:store',
      name: 'OpenClaw WebCLI',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('ci-openclaw-blaptop-bc.companionintelligence.com').length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy COMMON_HOSTNAME' }));
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ci-openclaw-blaptop-bc.companionintelligence.com');
    expect(toast.success).toHaveBeenCalledWith('SETTINGS_NETWORK_COPIED');

    MOCK_AVAILABLE_DOMAINS.domains = [];
    MOCK_CUSTOM_DOMAINS.supported = false;
    MOCK_CUSTOM_DOMAINS.domains = [];
  });

  it('shows a DNS-specific toast when DNS availability fails', async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const dnsMessage = 'DNS record already exists for ci-openclaw-blaptop-bc.companionintelligence.com';
    fetchDnsAvailability.mockResolvedValue(
      new Response(
        JSON.stringify({
          available: false,
          message: dnsMessage,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    vi.mocked(useAppContext).mockReturnValue({
      userSettings: {
        ciHubOrganizationSlug: 'bc',
        ciHubDeviceSlug: 'blaptop',
        localDomain: 'ci.lan',
        domain: 'companionintelligence.com',
        maxBackups: 5,
        guestDashboard: false,
      },
      user: { advancedMode: false },
      isProduction: true,
      cloudflareAvailable: true,
      tailscaleAvailable: false,
    } as unknown as ReturnType<typeof useAppContext>);

    const mockInfo = {
      urn: 'ci-openclaw:store',
      form_fields: [],
      exposable: true,
      dynamic_config: true,
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={mockInfo} onSubmit={onSubmit} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(dnsMessage);
  });

  // The enable-auth switch carries aria-label={name} (see Switch), so its accessible name is the
  // field name, not the translated label text.
  const getEnableAuthSwitch = () => screen.getByRole('switch', { name: 'enableAuth' });

  it('defaults the enable-auth switch ON for a fresh install', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo()} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getEnableAuthSwitch()).toBeChecked();
    });
  });

  it('lets the operator turn auth OFF on a fresh install without it bouncing back on', async () => {
    // The defaults effect re-runs when the form goes dirty (isDirty is a dependency). Without the
    // `!isDirty` guard it re-asserted the ON default over the operator's very first toggle, so the
    // switch appeared to snap back. One click must now stick.
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo()} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getEnableAuthSwitch()).toBeChecked());
    await act(async () => {
      fireEvent.click(getEnableAuthSwitch());
    });
    await waitFor(() => expect(getEnableAuthSwitch()).not.toBeChecked());
  });

  it('lets the operator switch exposure mode on a fresh install without it bouncing back', async () => {
    // Same init-effect hazard as enableAuth, on the field the effect seeds first: the resolved
    // default was written unconditionally, so the moment the operator picked a mode the form went
    // dirty, the effect re-ran, and the default overwrote the choice.
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo()} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    const modeButton = (key: string) => screen.getByRole('button', { name: `APP_INSTALL_FORM_EXPOSURE_${key}` });
    const isSelected = (key: string) => modeButton(key).className.includes('bg-primary');

    // Seeds to the first available mode (cloudflare) on the untouched form.
    await waitFor(() => expect(isSelected('CLOUDFLARE')).toBe(true));

    await act(async () => {
      fireEvent.click(modeButton('LOCAL'));
    });

    await waitFor(() => expect(isSelected('LOCAL')).toBe(true));
    expect(isSelected('CLOUDFLARE')).toBe(false);
  });

  it('reseeds every default when a dirty form is reused for a different app', async () => {
    // The dialog keeps one form instance across apps. Edits made against the PREVIOUS app are
    // stale, so a switch must reseed the whole form — not just the exposure mode, which would
    // leave the new app wearing half of its predecessor's config.
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    const { rerender } = render(
      <MemoryRouter>
        <InstallForm info={exposableInfo(3001)} onSubmit={vi.fn()} formId="test-form" formFields={[appBaseUrlField]} />
      </MemoryRouter>,
    );

    // Dirty the form against the first app: switch to Local and turn auth off.
    await waitFor(() => expect(getEnableAuthSwitch()).toBeChecked());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_EXPOSURE_LOCAL' }));
    });
    await act(async () => {
      fireEvent.click(getEnableAuthSwitch());
    });
    await waitFor(() => expect(getEnableAuthSwitch()).not.toBeChecked());

    // Now the same instance is handed a different app.
    const nextApp = { ...exposableInfo(4242), urn: 'other-app:store' } as never;
    rerender(
      <MemoryRouter>
        <InstallForm info={nextApp} onSubmit={vi.fn()} formId="test-form" formFields={[appBaseUrlField]} />
      </MemoryRouter>,
    );

    // Both the exposure mode AND the port/auth defaults belong to the new app.
    await waitFor(() => expect(getEnableAuthSwitch()).toBeChecked());
    expect(getAppBaseUrlInput()).not.toHaveValue('http://localhost:3001');
  });

  it('keeps a stored custom port when editing, rather than resetting to the manifest default', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    // Same init-effect hazard as enableAuth: the defaults run after initialValues are applied, so
    // an operator who moved the app off its manifest port (3001 → 9000) must not have that reset on
    // re-open. The Public URL field derives from the resolved port, so it reflects the stored value.
    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo(3001)}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[appBaseUrlField]}
          initialValues={{ exposureMode: 'local', port: '9000' }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getAppBaseUrlInput()).toHaveValue('http://localhost:9000');
    });
  });

  it('keeps the enable-auth switch OFF when editing an app saved with auth disabled', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    // The init effect must respect the stored operator choice: enableAuth is only defaulted to ON
    // when initialValues carry no explicit value, so a saved auth-OFF app stays OFF on re-open.
    render(
      <MemoryRouter>
        <InstallForm
          info={exposableInfo()}
          onSubmit={vi.fn()}
          formId="test-form"
          formFields={[]}
          initialValues={{ exposureMode: 'cloudflare', enableAuth: false }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getEnableAuthSwitch()).not.toBeChecked();
    });
  });

  it('shows the recommended hint when the manifest defaults edge auth on', async () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    const infoWithEdgeAuth = {
      ...(exposableInfo() as object),
      hub_integration: { edge_auth: { default: true } },
    } as unknown as AppInfo;

    render(
      <MemoryRouter>
        <InstallForm info={infoWithEdgeAuth} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText('APP_INSTALL_FORM_ENABLE_AUTH_RECOMMENDED')).toBeInTheDocument();
  });

  it('does not show the recommended hint for apps without an edge-auth default', () => {
    vi.mocked(useAppContext).mockReturnValue(exposableContext());

    render(
      <MemoryRouter>
        <InstallForm info={exposableInfo()} onSubmit={vi.fn()} formId="test-form" formFields={[]} />
      </MemoryRouter>,
    );

    expect(getEnableAuthSwitch()).toBeInTheDocument(); // the switch itself still renders
    expect(screen.queryByText('APP_INSTALL_FORM_ENABLE_AUTH_RECOMMENDED')).not.toBeInTheDocument();
  });

  // Regression coverage for CI-Hub #972: update-settings-dialog.tsx renders this same InstallForm
  // for the Edit Settings flow and passes `initialValues={{ ...config }}` — the app's LIVE env
  // values, including any auto-generated credential (`type: 'random'` in the catalog schema, e.g.
  // nextcloud's NEXTCLOUD_DB_PASSWORD or keila's SECRET_KEY_BASE). Before the fix, the
  // initialValues-seeding effect wrote every key into react-hook-form state with no type filter,
  // so a live secret ended up in getValues() and therefore in both the "Export config" download
  // and the "recently used" localStorage cache. These tests exercise that exact flow — a `random`
  // field (not `password`, which was already covered) present in `initialValues` — and assert the
  // secret reaches neither surface.
  describe('Edit Settings flow never leaks a live random-type secret (CI-Hub #972)', () => {
    const SECRET_VALUE = 'auto-generated-db-secret-abc123';
    const RANDOM_FIELD = {
      env_variable: 'DB_PASSWORD',
      label: 'Database Password',
      type: 'random',
      required: false,
    } as unknown as FormField;

    // Mirrors update-settings-dialog.tsx: `initialValues={{ ...config }}`.
    const editInitialValues = { DB_PASSWORD: SECRET_VALUE };

    const editInfo = {
      id: 'nextcloud',
      urn: 'nextcloud:store',
      form_fields: [RANDOM_FIELD],
      exposable: false,
      dynamic_config: false,
    } as unknown as AppInfo;

    beforeEach(() => {
      localStorage.clear();
      // cloudflareAvailable/tailscaleAvailable both false so exposureMode resolves to 'local' and
      // exposedLocal is false — keeps submit validation from requiring a subdomain, which is
      // unrelated to what this test is checking.
      vi.mocked(useAppContext).mockReturnValue({
        userSettings: {
          ciHubOrganizationSlug: undefined,
          localDomain: 'ci.lan',
          domain: 'example.com',
          maxBackups: 5,
          guestDashboard: false,
        },
        user: { advancedMode: true },
        isProduction: true,
        cloudflareAvailable: false,
        tailscaleAvailable: false,
      } as unknown as ReturnType<typeof useAppContext>);
    });

    // jsdom's `Blob` in this environment has no `.text()`, so a real Blob's content can't be read
    // back directly. Stub the global `Blob` constructor (same `vi.stubGlobal`/`unstubAllGlobals`
    // pattern used elsewhere in this repo, e.g. hub-status.test.tsx) with one that just records the
    // parts it was constructed with — `handleExportConfig` only ever passes the Blob straight to
    // the mocked `URL.createObjectURL`, so nothing else needs it to behave like a real Blob.
    class RecordingBlob {
      parts: unknown[];
      type?: string;
      constructor(parts: unknown[], options?: { type?: string }) {
        this.parts = parts;
        this.type = options?.type;
      }
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('never puts the live secret into the exported install-config file', () => {
      vi.stubGlobal('Blob', RecordingBlob);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-export');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(
        <MemoryRouter>
          <InstallForm info={editInfo} onSubmit={vi.fn()} formId="test-form" formFields={[RANDOM_FIELD]} initialValues={editInitialValues} />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole('button', { name: /APP_INSTALL_FORM_EXPORT_CONFIG/ }));

      expect(createObjectUrlSpy).toHaveBeenCalledOnce();
      const exportedBlob = createObjectUrlSpy.mock.calls[0]?.[0] as unknown as RecordingBlob;
      const exportedText = exportedBlob.parts.join('');

      expect(exportedText).not.toContain(SECRET_VALUE);
      expect(exportedText).not.toContain('DB_PASSWORD');
      expect(clickSpy).toHaveBeenCalledOnce();
    });

    // The desktop webview ignores `<a download>`, which left this button doing nothing there.
    it('saves the export through the desktop app and says where it went', async () => {
      class ReadableBlob extends RecordingBlob {
        async arrayBuffer() {
          return new TextEncoder().encode(this.parts.join('')).buffer;
        }
      }
      vi.stubGlobal('Blob', ReadableBlob);
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: vi.fn() }, configurable: true });
      mockTauriInvoke.mockResolvedValue('/home/user/Downloads/nextcloud-install-config.json');
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      try {
        render(
          <MemoryRouter>
            <InstallForm info={editInfo} onSubmit={vi.fn()} formId="test-form" formFields={[RANDOM_FIELD]} initialValues={editInitialValues} />
          </MemoryRouter>,
        );

        fireEvent.click(screen.getByRole('button', { name: /APP_INSTALL_FORM_EXPORT_CONFIG/ }));

        await waitFor(() => {
          expect(toast.success).toHaveBeenCalledWith('APP_INSTALL_FORM_EXPORT_CONFIG_SAVED');
        });
        expect(mockTauriInvoke).toHaveBeenCalledWith('save_download_command', {
          filename: 'nextcloud-install-config.json',
          contents: expect.any(Array),
        });
        const [, args] = mockTauriInvoke.mock.calls[0] as [string, { contents: number[] }];
        const savedText = new TextDecoder().decode(new Uint8Array(args.contents));
        expect(JSON.parse(savedText)).toMatchObject({ appId: 'nextcloud' });
        expect(savedText).not.toContain(SECRET_VALUE);
        expect(clickSpy).not.toHaveBeenCalled();
      } finally {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });

    it('reports a failed desktop save instead of failing silently', async () => {
      class ReadableBlob extends RecordingBlob {
        async arrayBuffer() {
          return new ArrayBuffer(0);
        }
      }
      vi.stubGlobal('Blob', ReadableBlob);
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: vi.fn() }, configurable: true });
      mockTauriInvoke.mockRejectedValue(new Error('Failed to write download'));

      try {
        render(
          <MemoryRouter>
            <InstallForm info={editInfo} onSubmit={vi.fn()} formId="test-form" formFields={[RANDOM_FIELD]} initialValues={editInitialValues} />
          </MemoryRouter>,
        );

        fireEvent.click(screen.getByRole('button', { name: /APP_INSTALL_FORM_EXPORT_CONFIG/ }));

        await waitFor(() => {
          expect(toast.error).toHaveBeenCalledWith('Failed to write download');
        });
      } finally {
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      }
    });

    it('never writes the live secret to the "recently used" localStorage cache on submit', async () => {
      const onSubmit = vi.fn();

      const { container } = render(
        <MemoryRouter>
          <InstallForm info={editInfo} onSubmit={onSubmit} formId="test-form" formFields={[RANDOM_FIELD]} initialValues={editInitialValues} />
        </MemoryRouter>,
      );

      const form = container.querySelector('form');
      expect(form).not.toBeNull();

      // RHF's submit handler runs the (async) `validate` function before calling onSubmit, so the
      // resulting state updates (recordLastUsedConfig + setRecentConfigs) land on a later
      // microtask — wrap in `act` and wait for them rather than asserting synchronously.
      await act(async () => {
        fireEvent.submit(form as HTMLFormElement);
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledOnce();
      });

      const raw = localStorage.getItem('ci-hub:last-install-configs:nextcloud');
      expect(raw).not.toBeNull();
      expect(raw).not.toContain(SECRET_VALUE);
      expect(raw).not.toContain('DB_PASSWORD');
    });
  });
});

/**
 * The drift banner named "Save settings", but nothing on the form is dirty when only
 * routing has drifted, so the Update button it pointed at stayed disabled and the
 * dialog dead-ended (#1208). It now carries the repair action itself.
 */
describe('InstallForm - Public Web routing drift', () => {
  const driftedApp = {
    urn: 'n8n:store',
    form_fields: [],
    exposable: true,
    dynamic_config: true,
    port: 3001,
  } as unknown as AppInfo;

  const context = {
    userSettings: {
      ciHubOrganizationSlug: 'bc',
      ciHubDeviceSlug: 'blaptop',
      localDomain: 'ci.lan',
      domain: 'companionintelligence.com',
      maxBackups: 5,
      guestDashboard: false,
    },
    user: { advancedMode: true },
    isProduction: true,
    cloudflareAvailable: true,
    tailscaleAvailable: false,
  } as unknown as ReturnType<typeof useAppContext>;

  const renderDrifted = (onSubmit: (values: Record<string, unknown>) => void = vi.fn()) =>
    render(
      <MemoryRouter>
        <InstallForm
          info={driftedApp}
          onSubmit={onSubmit}
          formId="test-form"
          formFields={[]}
          initialValues={{ exposureMode: 'cloudflare' }}
          appStatus="running"
          editingAppUrn="n8n:store"
        />
      </MemoryRouter>,
    );

  beforeEach(() => {
    // This describe is a SIBLING of `describe('InstallForm')`, so that block's
    // afterEach never runs for it and vitest is not configured to reset mocks
    // between files' suites. Without this, an implementation set over there (the
    // DNS stub in particular, whose single Response body is already consumed)
    // leaks in and can fire a toast these tests assert the absence of.
    vi.clearAllMocks();
    fetchDnsAvailability.mockReset();
    fetchDnsAvailability.mockResolvedValue(new Response(JSON.stringify({ available: true }), { status: 200 }));
    vi.mocked(useAppContext).mockReturnValue(context);
    fetchPublicWebDiagnostics.mockResolvedValue({
      apps: [{ appUrn: 'n8n:store', envMismatch: true, action: 'repair', computedPublicUrl: 'https://n8n-blaptop-bc.companionintelligence.com' }],
    });
  });

  afterEach(() => {
    // Restore the file-wide defaults so this suite's stubs cannot leak into another.
    fetchPublicWebDiagnostics.mockReset();
    fetchPublicWebDiagnostics.mockResolvedValue(null);
    repairPublicWebRouting.mockReset();
    fetchDnsAvailability.mockReset();
  });

  it('offers a repair action on the drift banner', async () => {
    renderDrifted();

    expect(await screen.findByTestId('public-web-drift-banner')).toBeInTheDocument();
    expect(screen.getByTestId('public-web-repair-button')).toBeEnabled();
  });

  it('repairs the edited app and clears the banner', async () => {
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'n8n:store', success: true }]);
    renderDrifted();

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(repairPublicWebRouting).toHaveBeenCalledWith('n8n:store');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('public-web-drift-banner')).not.toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('APP_PUBLIC_WEB_REPAIR_SUCCESS');
  });

  it('keeps the banner up when the repair fails', async () => {
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'n8n:store', success: false, message: 'App not found' }]);
    renderDrifted();

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('APP_PUBLIC_WEB_REPAIR_ERROR');
    });
    expect(screen.getByTestId('public-web-drift-banner')).toBeInTheDocument();
  });

  it('does not submit the config form when repairing', async () => {
    // The banner renders inside the config <form>, so a button that defaulted to
    // type="submit" would save the settings as a side effect of repairing routing.
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'n8n:store', success: true }]);
    const onSubmit = vi.fn();
    renderDrifted(onSubmit);

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(repairPublicWebRouting).toHaveBeenCalled();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears the banner when the Hub reports nothing left to repair', async () => {
    // The Hub returns a result per drifted app, so an empty list means this one is
    // already in sync — treating that as a failure would strand a stale banner.
    repairPublicWebRouting.mockResolvedValue([]);
    renderDrifted();

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('public-web-drift-banner')).not.toBeInTheDocument();
    });
    expect(toast.error).not.toHaveBeenCalled();
    // Nothing was rewritten and nothing restarted, so it must not claim a repair.
    expect(toast.success).toHaveBeenCalledWith('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED');
  });

  it('does not force a repair when the drift has resolved since the dialog opened', async () => {
    /*
     * The banner is drawn from a snapshot taken on open, and the server repairs a NAMED
     * app on `envMismatch` alone — deliberately overriding the `action: 'ok'` window a
     * freshly bound custom domain opens. Acting on the stale snapshot would force the
     * very restart that bind deferred.
     */
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'n8n:store', success: true }]);
    renderDrifted();
    await screen.findByTestId('public-web-drift-banner');

    fetchPublicWebDiagnostics.mockResolvedValue({
      apps: [{ appUrn: 'n8n:store', envMismatch: true, action: 'ok', computedPublicUrl: 'https://n8n-blaptop-bc.companionintelligence.com' }],
    });
    fireEvent.click(screen.getByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED');
    });
    expect(repairPublicWebRouting).not.toHaveBeenCalled();
    expect(screen.queryByTestId('public-web-drift-banner')).not.toBeInTheDocument();
  });

  it('repairs nothing when the drift cannot be re-read', async () => {
    // Unverified state is not a licence to restart the app; the operator can retry.
    renderDrifted();
    await screen.findByTestId('public-web-drift-banner');

    fetchPublicWebDiagnostics.mockResolvedValue(null);
    fireEvent.click(screen.getByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('APP_PUBLIC_WEB_REPAIR_ERROR');
    });
    expect(repairPublicWebRouting).not.toHaveBeenCalled();
    expect(screen.getByTestId('public-web-drift-banner')).toBeInTheDocument();
  });

  it('surfaces the reason when the operator holds no grant for the app', async () => {
    // The Hub answers a denied repair with APP_ACTION_GRANT_DENIED, and telling that
    // operator to "check the Hub logs" would send them hunting a fault that is not there.
    repairPublicWebRouting.mockRejectedValue(new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'configure', app: 'n8n' }));
    renderDrifted();

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('APP_ACTION_GRANT_DENIED');
    });
    expect(screen.getByTestId('public-web-drift-banner')).toBeInTheDocument();
  });

  it('re-enables the repair button after a failed attempt so it can be retried', async () => {
    repairPublicWebRouting.mockRejectedValue(new Error('network down'));
    renderDrifted();

    fireEvent.click(await screen.findByTestId('public-web-repair-button'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('public-web-repair-button')).toBeEnabled();
    });
  });
});
