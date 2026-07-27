import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './login-page';

const { mockUseUserContext, mockUseMutation, mockNavigate, mockSearchParams, mockLoginForm, mockClientGetConfig, mockToastError, mockToastSuccess } =
  vi.hoisted(() => ({
    mockUseUserContext: vi.fn(),
    mockUseMutation: vi.fn(),
    mockNavigate: vi.fn(),
    mockSearchParams: vi.fn(),
    mockLoginForm: vi.fn(({ loginType }: { loginType: string }) => <div data-testid="login-type">{loginType}</div>),
    mockClientGetConfig: vi.fn(),
    mockToastError: vi.fn(),
    mockToastSuccess: vi.fn(),
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
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });

    render(<LoginPage />);

    expect(mockLoginForm).toHaveBeenCalledWith(
      expect.objectContaining({
        portalSsoHref: 'http://localhost:5002/api/auth/portal/start?desktop=1',
      }),
    );

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
