import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './login-page';

const {
  mockUseUserContext,
  mockUseMutation,
  mockNavigate,
  mockSearchParams,
  mockLoginForm,
  mockClientGetConfig,
  mockToastError,
  mockToastSuccess,
  mockIsMobile,
  mockHubUrl,
  mockResolveHint,
  mockIsTauriDesktopApp,
} = vi.hoisted(() => ({
  mockUseUserContext: vi.fn(),
  mockUseMutation: vi.fn(),
  mockNavigate: vi.fn(),
  mockSearchParams: vi.fn(),
  mockLoginForm: vi.fn(({ loginType }: { loginType: string }) => <div data-testid="login-type">{loginType}</div>),
  mockClientGetConfig: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockIsMobile: vi.fn(() => false),
  mockHubUrl: vi.fn((): string | null => null),
  mockResolveHint: vi.fn(
    async (): Promise<{ email: string | null; portalBaseUrl: string | null; source: string | null }> => ({
      email: null,
      portalBaseUrl: null,
      source: null,
    }),
  ),
  mockIsTauriDesktopApp: vi.fn(() => false),
}));

vi.mock('@/lib/hub-runtime-mode', () => ({
  isTauriDesktopApp: () => mockIsTauriDesktopApp(),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => mockIsMobile(),
  usesCloudConnect: () => mockIsMobile(),
  getHubBaseUrlSync: () => mockHubUrl(),
  clearHubConnection: vi.fn(async () => {}),
}));

vi.mock('@/lib/portal-session-hint', () => ({
  resolvePortalSessionHint: () => mockResolveHint(),
  forgetPortalAccountEmail: vi.fn(),
}));

vi.mock('@/api-client', () => ({
  userContext: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  loginMutation: vi.fn(() => ({})),
  verifyTotpMutation: vi.fn(() => ({})),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    getConfig: () => mockClientGetConfig(),
  },
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  setTauriSessionId: vi.fn(),
}));

vi.mock('@/lib/safe-redirect', () => ({
  followSafeRedirect: vi.fn(() => false),
}));

vi.mock('@/lib/deep-link-auth', () => ({
  takePendingDesktopPortalAuth: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => mockUseUserContext(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => mockUseMutation(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
    useNavigate: () => mockNavigate,
    useSearchParams: () => mockSearchParams(),
  };
});

vi.mock('../components/login-form', () => ({
  LoginForm: (props: { loginType: string }) => mockLoginForm(props),
}));

vi.mock('../components/totp-form/totp-form', () => ({
  TotpForm: () => <div data-testid="totp-form" />,
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauriDesktopApp.mockReturnValue(false);
    mockClientGetConfig.mockReturnValue({ baseUrl: 'http://localhost:5002' });
    mockUseUserContext.mockReturnValue({
      isLoggedIn: false,
      isConfigured: true,
      refreshUserContext: vi.fn(),
      setUserContext: vi.fn(),
    });
    mockUseMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    mockSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockIsMobile.mockReturnValue(false);
    mockHubUrl.mockReturnValue(null);
    mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null });
  });

  it('defaults the login heading to the local admin account copy', () => {
    render(<LoginPage />);

    expect(screen.getByTestId('login-type')).toHaveTextContent('AUTH_LOGIN_LOCAL_ADMIN_ACCOUNT');
  });

  it('surfaces the reason the client signed itself out, then strips it from the URL', () => {
    // A password or username change revokes every session, so its confirmation cannot be
    // shown where it was triggered — the page reloads into a signed-out state. It rides
    // the URL to here instead.
    const setSearchParams = vi.fn();
    mockSearchParams.mockReturnValue([new URLSearchParams('signed_out=password_changed'), setSearchParams]);

    render(<LoginPage />);

    expect(mockToastSuccess).toHaveBeenCalledWith('SETTINGS_SECURITY_PASSWORD_CHANGE_SUCCESS');
    const strip = setSearchParams.mock.calls[0]?.[0] as (prev: URLSearchParams) => URLSearchParams;
    expect(strip(new URLSearchParams('signed_out=password_changed')).has('signed_out')).toBe(false);
  });

  it('says nothing for an unrecognised sign-out reason', () => {
    mockSearchParams.mockReturnValue([new URLSearchParams('signed_out=nonsense'), vi.fn()]);

    render(<LoginPage />);

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('uses the local backend desktop callback flow in Tauri', () => {
    mockIsTauriDesktopApp.mockReturnValue(true);
    mockClientGetConfig.mockReturnValue({ baseUrl: 'http://localhost:5002' });

    render(<LoginPage />);

    expect(mockLoginForm).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSsoHref: 'http://localhost:5002/api/auth/portal/start?desktop=1&desktop_channel=dev',
        openPortalSsoExternally: true,
      }),
    );
  });

  it('starts Companion Account SSO on the Vite origin during local:desktop, not a leftover :5002 Hub', () => {
    mockIsTauriDesktopApp.mockReturnValue(true);
    mockClientGetConfig.mockReturnValue({ baseUrl: 'http://localhost:5002' });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, origin: 'http://localhost:5005', port: '5005' },
    });

    render(<LoginPage />);

    expect(mockLoginForm).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSsoHref: 'http://localhost:5005/api/auth/portal/start?desktop=1&desktop_channel=dev',
        openPortalSsoExternally: true,
      }),
    );
  });

  it('keeps browser Hub login on the page origin without a cihub:// handoff', () => {
    render(<LoginPage />);

    expect(mockLoginForm).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSsoHref: `${window.location.origin}/api/auth/portal/start`,
        openPortalSsoExternally: false,
      }),
    );
  });

  it('points Portal SSO at the chosen remote Hub on iOS/Android (not localhost:5002)', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mockIsMobile.mockReturnValue(true);
    mockHubUrl.mockReturnValue('https://hub-core3-bc.companionintelligence.com');

    render(<LoginPage />);

    expect(mockLoginForm).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSsoHref: 'https://hub-core3-bc.companionintelligence.com/api/auth/portal/start?desktop=1',
        openPortalSsoExternally: true,
      }),
    );
    expect(screen.getByTestId('login-switch-hub-btn')).toBeInTheDocument();

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('labels Companion Account with the Portal user, not the Hub operator', async () => {
    mockIsMobile.mockReturnValue(true);
    mockHubUrl.mockReturnValue('https://hub-core3-bc.companionintelligence.com');
    mockResolveHint.mockResolvedValue({
      email: 'user@example.com',
      portalBaseUrl: 'https://hub.ci.computer',
      source: 'remembered',
    });

    render(<LoginPage />);

    await vi.waitFor(() => {
      expect(mockLoginForm).toHaveBeenCalledWith(
        expect.objectContaining({
          portalAccountEmail: 'user@example.com',
        }),
      );
    });
  });
});
