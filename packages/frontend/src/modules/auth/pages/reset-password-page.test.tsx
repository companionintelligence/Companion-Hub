import { fireEvent, render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage from './reset-password-page';

const { navigate, mockUseQuery, mockUseMutation } = vi.hoisted(() => ({
  navigate: vi.fn(),
  mockUseQuery: vi.fn(),
  mockUseMutation: vi.fn(),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: mockUseQuery,
    useMutation: mockUseMutation,
  };
});

vi.mock('@/context/user-context', () => ({
  useUserContext: () => ({
    isPasswordResetDisabled: false,
    domain: 'example.com',
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  checkResetPasswordRequestOptions: () => ({}),
  resetPasswordMutation: () => ({}),
  cancelResetPasswordMutation: () => ({}),
}));

vi.mock('react-hot-toast', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
    Trans: ({ values }: { values?: Record<string, string> }) => values?.username ?? null,
  };
});

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseMutation.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
      data: undefined,
    });
  });

  it('shows fallback instructions and back-to-login action when status query fails', () => {
    mockUseQuery.mockReturnValue({
      isError: true,
      isLoading: false,
      data: undefined,
    });

    render(<ResetPasswordPage />);

    expect(screen.getByText('AUTH_RESET_PASSWORD_TITLE')).toBeInTheDocument();
    expect(screen.getByText('AUTH_RESET_PASSWORD_INSTRUCTIONS')).toBeInTheDocument();
    expect(screen.getByText('./ci-hub-cli reset-password')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_BACK_TO_LOGIN' }));

    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
