import { render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './login-page';

const { mockUseUserContext, mockUseMutation, mockNavigate, mockSearchParams, mockLoginForm } = vi.hoisted(() => ({
  mockUseUserContext: vi.fn(),
  mockUseMutation: vi.fn(),
  mockNavigate: vi.fn(),
  mockSearchParams: vi.fn(),
  mockLoginForm: vi.fn(({ loginType }: { loginType: string }) => <div data-testid="login-type">{loginType}</div>),
}));

vi.mock('@/api-client', () => ({
  userContext: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  loginMutation: vi.fn(() => ({})),
  verifyTotpMutation: vi.fn(() => ({})),
}));

vi.mock('@/lib/api-fetch', () => ({
  setTauriSessionId: vi.fn(),
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

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(screen.getByTestId('login-type')).toHaveTextContent('your local admin account');
  });
});
