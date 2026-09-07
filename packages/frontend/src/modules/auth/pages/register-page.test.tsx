import { render, screen, userEvent } from '@/tests/test-utils';
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
    ({ loading, onSubmit }: { loading: boolean; onSubmit: (values: { email: string; password: string; passwordConfirm: string }) => void }) => (
      <button
        type="button"
        disabled={loading}
        onClick={() => onSubmit({ email: 'admin@example.test', password: 'password123', passwordConfirm: 'password123' })}
      >
        register form
      </button>
    ),
  ),
  mockFollowSafeRedirect: vi.fn((_url: string | null) => false),
  mockMarkSessionIssuedAt: vi.fn(),
}));

const { mockUserContext } = vi.hoisted(() => ({
  mockUserContext: vi.fn(),
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
  };
});

vi.mock('../components/register-form', () => ({
  RegisterForm: (props: { loading: boolean; onSubmit: (values: { email: string; password: string; passwordConfirm: string }) => void }) =>
    mockRegisterForm(props),
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
});
