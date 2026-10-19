import en from '@ci-hub/common/i18n/translations/en.json';
import { act, fireEvent, render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTAL_RECHECK_INTERVAL_MS } from '../hooks/use-portal-sign-in';
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

const { mockUserContext, mockResolveRegistrationStatus } = vi.hoisted(() => ({
  mockUserContext: vi.fn(),
  mockResolveRegistrationStatus: vi.fn(async (): Promise<{ phase: string; registered: boolean; degradedReasons: string[] } | null> => null),
}));

vi.mock('@/lib/registration-cache', () => ({
  resolveRegistrationStatus: () => mockResolveRegistrationStatus(),
}));

const { mockIsTauriDesktopApp, mockIsMobile, mockHubUrl, mockResolveHint, mockForgetPortalAccountEmail, mockOpenAuthSession, mockClientGetConfig } =
  vi.hoisted(() => ({
    mockIsTauriDesktopApp: vi.fn(() => false),
    mockIsMobile: vi.fn(() => false),
    mockHubUrl: vi.fn((): string | null => null),
    mockResolveHint: vi.fn(async () => ({ email: null as string | null, portalBaseUrl: null, source: null, portalReachable: true })),
    mockForgetPortalAccountEmail: vi.fn(),
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
  forgetPortalAccountEmail: () => mockForgetPortalAccountEmail(),
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

  it('renders first-user registration when the Hub has no operator and is not paired', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: false, isLoggedIn: false } });
    mockResolveRegistrationStatus.mockResolvedValue({ phase: 'unregistered', registered: false, degradedReasons: [] });

    await expect(clientLoader()).resolves.toBeNull();
  });

  it('renders it when the registration status cannot be read, as before', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: false, isLoggedIn: false } });
    mockResolveRegistrationStatus.mockResolvedValue(null);

    await expect(clientLoader()).resolves.toBeNull();
  });

  // #2061: a paired Hub revoked the CI Account this form made, at its next check-in.
  it('sends a paired Hub with no admin yet to sign-in instead', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: false, isLoggedIn: false } });
    mockResolveRegistrationStatus.mockResolvedValue({ phase: 'publicly_ready', registered: true, degradedReasons: [] });

    const result = (await clientLoader({ request: new Request('http://localhost/register') })) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe('/login');
  });

  it('keeps redirect_url on the way to sign-in', async () => {
    mockUserContext.mockResolvedValue({ data: { isConfigured: false, isLoggedIn: false } });
    mockResolveRegistrationStatus.mockResolvedValue({ phase: 'locally_ready', registered: true, degradedReasons: [] });

    const result = (await clientLoader({ request: new Request('http://localhost/register?redirect_url=%2Fstore') })) as Response;

    expect(result.headers.get('Location')).toBe('/login?redirect_url=%2Fstore');
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

  // A paired Hub opens on /login now (#2061). This page still offers the CI Account sign-in for the
  // rare Hub that renders it, because whoever paired a Hub already has a CI Account (#2059).
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

    it('signs in as someone else from the desktop app', async () => {
      mockIsTauriDesktopApp.mockReturnValue(true);
      mockResolveHint.mockResolvedValue({ email: 'owner@example.test', portalBaseUrl: null, source: null, portalReachable: true });

      render(<RegisterPage />);

      await userEvent.click(await screen.findByTestId('login-switch-account'));

      expect(mockForgetPortalAccountEmail).toHaveBeenCalledOnce();
      expect(mockOpenAuthSession).toHaveBeenCalledWith('http://localhost:5002/api/auth/portal/start?desktop=1&desktop_channel=dev');
      expect(screen.queryByTestId('login-switch-account')).not.toBeInTheDocument();
    });

    it('turns the button off and says why while Portal cannot be reached', async () => {
      mockIsTauriDesktopApp.mockReturnValue(true);
      mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });

      render(<RegisterPage />);

      await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled());
      // Not the /login hint: that one sends people to a password form that works offline, and the
      // sign-up form here needs Portal as well.
      expect(screen.getByText('AUTH_REGISTER_PORTAL_UNREACHABLE')).toBeInTheDocument();
      expect(screen.queryByText('AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET')).not.toBeInTheDocument();
    });

    // #2061: the answer was read once, so a page opened before Portal was reachable kept the button
    // off until a reload.
    describe('when Portal comes back', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('turns the button on at the next recheck', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        mockIsTauriDesktopApp.mockReturnValue(true);
        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });

        render(<RegisterPage />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled());

        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PORTAL_RECHECK_INTERVAL_MS);
        });

        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeEnabled());
        expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT')).toBeInTheDocument();
      });

      it('turns the button on when the browser comes back online', async () => {
        mockIsTauriDesktopApp.mockReturnValue(true);
        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });

        render(<RegisterPage />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled());

        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
        fireEvent(window, new Event('online'));

        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeEnabled());
      });

      it('never starts asking when Portal answers on load', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });

        render(<RegisterPage />);
        await waitFor(() => expect(mockResolveHint).toHaveBeenCalledTimes(1));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PORTAL_RECHECK_INTERVAL_MS * 3);
        });

        expect(mockResolveHint).toHaveBeenCalledTimes(1);
      });

      it('stops asking once a recheck finds Portal', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        mockIsTauriDesktopApp.mockReturnValue(true);
        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });

        render(<RegisterPage />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled());

        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: true });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PORTAL_RECHECK_INTERVAL_MS);
        });
        await waitFor(() => expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeEnabled());
        expect(mockResolveHint).toHaveBeenCalledTimes(2);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(PORTAL_RECHECK_INTERVAL_MS * 3);
        });

        expect(mockResolveHint).toHaveBeenCalledTimes(2);
      });

      it('skips its turn while the page is hidden', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        mockResolveHint.mockResolvedValue({ email: null, portalBaseUrl: null, source: null, portalReachable: false });
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

        try {
          render(<RegisterPage />);
          await waitFor(() => expect(mockResolveHint).toHaveBeenCalledTimes(1));

          await act(async () => {
            await vi.advanceTimersByTimeAsync(PORTAL_RECHECK_INTERVAL_MS * 3);
          });

          expect(mockResolveHint).toHaveBeenCalledTimes(1);
        } finally {
          visibility.mockRestore();
        }
      });
    });

    it('sends the person to sign-in when the backend refuses sign-up on a paired Hub', async () => {
      window.history.replaceState({}, '', '/register?redirect_url=%2Fsettings');
      mockUseMutation.mockImplementation((options) => {
        mutate = vi.fn(() => options.onError?.({ message: 'AUTH_ERROR_REGISTER_PAIRED_HUB' })) as typeof mutate;
        return { mutate, isPending: false };
      });

      render(<RegisterPage />);

      await userEvent.click(screen.getByRole('button', { name: 'register form' }));

      expect(mockToastError).toHaveBeenCalledWith('AUTH_ERROR_REGISTER_PAIRED_HUB');
      expect(mockNavigate).toHaveBeenCalledWith('/login?redirect_url=%2Fsettings', { replace: true });
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
