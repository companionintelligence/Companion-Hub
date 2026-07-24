import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './login-page';

const { mockUseUserContext, mockUseMutation, mockNavigate, mockSearchParams, mockLoginForm, mockClientGetConfig } = vi.hoisted(() => ({
  mockUseUserContext: vi.fn(),
  mockUseMutation: vi.fn(),
  mockNavigate: vi.fn(),
  mockSearchParams: vi.fn(),
  mockLoginForm: vi.fn(({ loginType }: { loginType: string }) => <div data-testid="login-type">{loginType}</div>),
  mockClientGetConfig: vi.fn(),
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
    error: vi.fn(),
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

describe('isSafeRedirect', () => {
  // jsdom's test origin is http://localhost:3000.
  it('allows a relative path but rejects a protocol-relative one', async () => {
    const { isSafeRedirect } = await import('./login-page');
    expect(isSafeRedirect('/home')).toBe(true);
    expect(isSafeRedirect('/api/auth/edge-sso?redirect=x')).toBe(true);
    // `//evil.com` is protocol-relative — the browser would leave the origin.
    expect(isSafeRedirect('//evil.com/phish')).toBe(false);
  });

  it('allows a same-origin absolute URL (the edge-SSO return address)', async () => {
    const { isSafeRedirect } = await import('./login-page');
    expect(isSafeRedirect(`${window.location.origin}/api/auth/edge-sso?redirect=https%3A%2F%2Fapp`)).toBe(true);
  });

  it('keeps the historical LAN shape: subdomains of the current host', async () => {
    const { isSafeRedirect } = await import('./login-page');
    expect(isSafeRedirect(`http://app.${window.location.host}/dashboard`)).toBe(true);
  });

  it('rejects foreign origins and unparsable values instead of throwing', async () => {
    const { isSafeRedirect } = await import('./login-page');
    expect(isSafeRedirect('https://evil.example.com/')).toBe(false);
    // The old implementation THREW on non-absolute input, taking the login page down.
    expect(isSafeRedirect('not a url')).toBe(false);
  });
});

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
