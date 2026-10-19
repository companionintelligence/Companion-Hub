import en from '@ci-hub/common/i18n/translations/en.json';
import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RegisterPage, { clientLoader } from './register-page';

const {
  mockUseUserContext,
  mockUseMutation,
  mockNavigate,
  mockToastError,
  mockToastSuccess,
  mockRegisterForm,
  mockFollowSafeRedirect,
  mockMarkSessionIssuedAt,
} = vi.hoisted(() => ({
  mockUseUserContext: vi.fn(),
  mockUseMutation: vi.fn(),
  mockNavigate: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockRegisterForm: vi.fn(
    ({
      loading,
      onSubmit,
      portalSignIn,
      signInHref,
    }: {
      loading: boolean;
      onSubmit: (values: { email: string; password: string; passwordConfirm: string }) => void;
      portalSignIn?: React.ReactNode;
      signInHref?: string;
    }) => (
      <>
        {portalSignIn}
        <button
          type="button"
          disabled={loading}
          onClick={() => onSubmit({ email: 'admin@example.test', password: 'password123', passwordConfirm: 'password123' })}
        >
          register form
        </button>
        <span data-testid="sign-in-href">{signInHref}</span>
      </>
    ),
  ),
  mockFollowSafeRedirect: vi.fn((_url: string | null) => false),
  mockMarkSessionIssuedAt: vi.fn(),
}));

const { mockUserContext } = vi.hoisted(() => ({
  mockUserContext: vi.fn(),
}));

const { mockIsTauriDesktopApp, mockIsMobile, mockHubUrl, mockResolveHint, mockOpenAuthSession, mockClientGetConfig } = vi.hoisted(() => ({
  mockIsTauriDesktopApp: vi.fn(() => false),
  mockIsMobile: vi.fn(() => false),
  mockHubUrl: vi.fn((): string | null => null),
  mockResolveHint: vi.fn(async () => ({ email: null as string | null, portalBaseUrl: null, source: null, portalReachable: true })),
  mockOpenAuthSession: vi.fn(async (_url: string) => {}),
  mockClientGetConfig: vi.fn(() => ({ baseUrl: 'http://localhost:5002' })),
}));

vi.mock('@/lib/hub-runtime-mode', () => ({
  isTauriDesktopApp: () => mockIsTauriDesktopApp(),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => mockIsMobile(),
  usesCloudConnect: () => mockIsMobile(),
  getHubBaseUrlSync: () => mockHubUrl(),
}));

vi.mock('@/lib/portal-session-hint', () => ({
  resolvePortalSessionHint: () => mockResolveHint(),
  forgetPortalAccountEmail: vi.fn(),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    getConfig: () => mockClientGetConfig(),
  },
}));

vi.mock('@/lib/helpers/open-auth-browser', () => ({
  openAuthSession: (url: string) => mockOpenAuthSession(url),
  AuthSessionCancelledError: class AuthSessionCancelledError extends Error {},
}));

vi.mock('@/api-client', () => ({
  userContext: () => mockUserContext(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  registerMutation: vi.fn(() => ({})),
}));

vi.mock('@/context/user-context', () => ({
  useUserContext: () => mockUseUserContext(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => mockUseMutation(options),
}));

vi.mock('@/lib/api-fetch', () => ({
  markHubSessionIssuedAt: () => mockMarkSessionIssuedAt(),
}));

vi.mock('@/lib/safe-redirect', () => ({
  followSafeRedirect: (url: string | null) => mockFollowSafeRedirect(url),
}));

vi.mock('sonner', () => ({
  toast: {
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
  };
});

vi.mock('../components/register-form', () => ({
  RegisterForm: (props: {
    loading: boolean;
    onSubmit: (values: { email: string; password: string; passwordConfirm: string }) => void;
    portalSignIn?: React.ReactNode;
    signInHref?: string;
  }) => mockRegisterForm(props),
}));

describe('RegisterPage clientLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders first-user registration when the Hub has no operator', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: false, isLoggedIn: false } });

    await expect(clientLoader()).resolves.toBeNull();
  });

  it('redirects configured logged-out Hubs to login', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: true, isLoggedIn: false } });

    const result = (await clientLoader()) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/login');
  });
});

describe('RegisterPage', () => {
  const refreshUserContext = vi.fn();
  const setUserContext = vi.fn();
  let mutate: (values: { body: { username: string; password: string } }) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/register');
    mockIsTauriDesktopApp.mockReturnValue(false);
    mockIsMobile.mockReturnValue(false);
    mockHubUrl.mockReturnValue(null);
    mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
    mockUseUserContext.mockReturnValue({
      isLoggedIn: false,
      isConfigured: false,
      refreshUserContext,
      setUserContext,
    });
    mockUseMutation.mockImplementation((options) => {
      mutate = vi.fn((values) => options.onSuccess?.({ success: true }, values, undefined)) as typeof mutate;
      return { mutate, isPending: false };
    });
  });

  it('submits first-user credentials and opens onboarding after registration', async () => {
    render(<RegisterPage />);

    await userEvent.click(screen.getByRole('button', { name: 'register form' }));

    expect(mutate).toHaveBeenCalledWith({ body: { username: 'admin@example.test', password: 'password123' } });
    expect(mockMarkSessionIssuedAt).toHaveBeenCalledOnce();
    expect(setUserContext).toHaveBeenCalledWith({ isLoggedIn: true, isConfigured: true });
    expect(refreshUserContext).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('/onboarding');
  });

  it('shows the email-verification toast instead of a raw i18n key', async () => {
    mockUseMutation.mockImplementation((options) => {
      mutate = vi.fn((values) => options.onSuccess?.({ success: true, requiresEmailVerification: true }, values, undefined)) as typeof mutate;
      return { mutate, isPending: false };
    });

    render(<RegisterPage />);

    await userEvent.click(screen.getByRole('button', { name: 'register form' }));

    expect(mockToastSuccess).toHaveBeenCalledWith('AUTH_REGISTER_VERIFY_EMAIL');
    expect(en.AUTH_REGISTER_VERIFY_EMAIL).toBe('Check your email to verify your CI Account, then sign in.');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockMarkSessionIssuedAt).not.toHaveBeenCalled();
  });

  it('keeps configured users on login', () => {
    mockUseUserContext.mockReturnValue({
      isLoggedIn: false,
      isConfigured: true,
      refreshUserContext,
      setUserContext,
    });

    render(<RegisterPage />);

    expect(screen.getByTestId('navigate')).toHaveTextContent('/login');
  });

  // A paired Hub with no operator opens on this page, after any restart between pairing and the
  // first sign-in. Whoever paired it already has a CI Account (#2059).
  describe('CI Account sign-in', () => {
    it('opens CI Account sign-in in the system browser from the desktop app', async () => {
      mockIsTauriDesktopApp.mockReturnValue(true);

      render(<RegisterPage />);

      await userEvent.click(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' }));

      expect(mockOpenAuthSession).toHaveBeenCalledWith('http://localhost:5002/api/auth/portal/start?desktop=1&desktop_channel=dev');
      expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT')).toBeInTheDocument();
    });

    it('links a browser already on the Hub to Portal sign-in in place', () => {
      render(<RegisterPage />);

      expect(screen.getByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toHaveAttribute(
        'href',
        `${window.location.origin}/api/auth/portal/start`,
      );
      expect(mockOpenAuthSession).not.toHaveBeenCalled();
    });

    it('names the Portal account it will sign in as, with a way to pick another', async () => {
      mockResolveHint.mockResolvedValue({ email: 'owner@example.test', portalBaseUrl: null, source: null, portalReachable: true });

      render(<RegisterPage />);

      expect(await screen.findByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS' })).toBeInTheDocument();
      expect(screen.getByTestId('login-switch-account')).toBeInTheDocument();
    });

    it('turns the button off and says why while Portal cannot be reached', async () => {
      mockIsTauriDesktopApp.mockReturnValue(true);
      mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });

      render(<RegisterPage />);

      await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled());
      expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET')).toBeInTheDocument();
    });

    it('keeps the page a sign-up form on a phone that has not chosen a Hub, where Hub sign-in does not apply', () => {
      mockIsMobile.mockReturnValue(true);

      render(<RegisterPage />);

      expect(screen.queryByText('AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'register form' })).toBeInTheDocument();
    });

    it('links to the sign-in page for an existing CI Account', () => {
      render(<RegisterPage />);

      expect(screen.getByTestId('sign-in-href')).toHaveTextContent(/^\/login$/);
    });

    it('carries redirect_url into both ways of signing in', () => {
      window.history.replaceState({}, '', '/register?redirect_url=%2Fstore%2Fci-marketplace%2Fimmich');

      render(<RegisterPage />);

      expect(screen.getByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toHaveAttribute(
        'href',
        `${window.location.origin}/api/auth/portal/start?redirect_url=%2Fstore%2Fci-marketplace%2Fimmich`,
      );
      expect(screen.getByTestId('sign-in-href')).toHaveTextContent('/login?redirect_url=%2Fstore%2Fci-marketplace%2Fimmich');
    });
  });
});
