import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { AppInfo } from '@/types/app.types';
import { InstallForm } from './install-form';
import { useAppContext } from '@/context/app-context';

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

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch,
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
}));

vi.mock('@ci-hub/common/types', () => {
  const sanitizeAppSubdomain = (subdomain: string) =>
    (subdomain.split('.')[0] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  const buildPublicWebIdentity = ({
    appSubdomain,
    hubSubdomain,
    orgSlug,
    publicDomainRoot,
  }: {
    appSubdomain: string;
    hubSubdomain?: string | null;
    orgSlug?: string | null;
    publicDomainRoot: string;
  }) => {
    const cleanAppSubdomain = sanitizeAppSubdomain(appSubdomain);
    if (!orgSlug) {
      const hostname = `${cleanAppSubdomain}.${publicDomainRoot}`;
      return { hostname, publicUrl: `https://${hostname}`, publicDnsHostname: hostname, appSubdomain: cleanAppSubdomain, publicDomainRoot };
    }

    const withoutPrefix = (hubSubdomain ?? '').replace(/^hub-/, '');
    const orgSuffix = `-${orgSlug}`;
    const deviceSlug = withoutPrefix.endsWith(orgSuffix) ? withoutPrefix.slice(0, -orgSuffix.length) : withoutPrefix;
    const fqdnSubdomain = deviceSlug && deviceSlug !== orgSlug ? `${cleanAppSubdomain}-${deviceSlug}-${orgSlug}` : `${cleanAppSubdomain}-${orgSlug}`;
    const hostname = `${fqdnSubdomain}.${publicDomainRoot}`;
    return { hostname, publicUrl: `https://${hostname}`, publicDnsHostname: hostname, appSubdomain: cleanAppSubdomain, publicDomainRoot };
  };

  const buildTailscalePortHost = (nodeFqdn?: string | null, port?: number | null) => {
    if (!nodeFqdn || !port) return null;
    return `${nodeFqdn}:${port}`;
  };

  return {
    buildPublicWebIdentity,
    buildTailscalePortHost,
    sanitizeAppSubdomain,
  };
});

const MOCK_AVAILABLE_DOMAINS = { domains: [] as Array<{ id: string; domain: string; isDefault: boolean; scope?: string }> };
const MOCK_USE_QUERY_RESULT = {
  data: MOCK_AVAILABLE_DOMAINS,
  isLoading: false,
};

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useQuery: () => MOCK_USE_QUERY_RESULT,
  queryOptions: (options: unknown) => options,
}));

// Mock API client if needed
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getRandomPortMutation: () => ({ mutationFn: vi.fn() }),
}));

describe('InstallForm', () => {
  afterEach(() => {
    MOCK_AVAILABLE_DOMAINS.domains = [];
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

  it('should fallback to local domain when organization slug is missing', () => {
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

    // Expect to see "-ci.lan"
    expect(screen.getByText(/-ci.lan/)).toBeInTheDocument();
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
    apiFetch.mockResolvedValue(
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
    apiFetch.mockResolvedValue(
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

    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('appUrn=ci-openclaw%3Astore'), expect.objectContaining({ credentials: 'include' }));
  });

  it('does not keep rechecking DNS availability after a successful response', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(
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

    expect(apiFetch).toHaveBeenCalledTimes(1);
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

    expect(apiFetch).not.toHaveBeenCalled();
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
  });

  it('shows a DNS-specific toast when DNS availability fails', async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    const dnsMessage = 'DNS record already exists for ci-openclaw-blaptop-bc.companionintelligence.com';
    apiFetch.mockResolvedValue(
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
});
