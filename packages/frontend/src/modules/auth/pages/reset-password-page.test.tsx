import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage from './reset-password-page';

const { mockVerifyResetPasswordToken, mockRequestResetPassword, mockCompleteResetPassword, mockNavigate, mockSearchParams, toast } = vi.hoisted(
  () => ({
    mockVerifyResetPasswordToken: vi.fn(),
    mockRequestResetPassword: vi.fn(),
    mockCompleteResetPassword: vi.fn(),
    mockNavigate: vi.fn(),
    mockSearchParams: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
  }),
);

vi.mock('@/lib/auth-password-reset-api', () => ({
  verifyResetPasswordToken: (...args: unknown[]) => mockVerifyResetPasswordToken(...args),
  requestResetPassword: (...args: unknown[]) => mockRequestResetPassword(...args),
  completeResetPassword: (...args: unknown[]) => mockCompleteResetPassword(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams(), vi.fn()],
}));

vi.mock('sonner', () => ({
  toast: toast,
}));

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    mockVerifyResetPasswordToken.mockResolvedValue(false);
    mockRequestResetPassword.mockResolvedValue({ ok: true });
    mockCompleteResetPassword.mockResolvedValue({ ok: true });
  });

  it('renders email request flow and removes demo credentials copy', () => {
    render(<ResetPasswordPage />);

    expect(screen.queryByText('Demo Account Credentials')).not.toBeInTheDocument();
    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_REQUEST_SUBMIT' })).toBeInTheDocument();
  });

  it('shows generic success message after requesting a reset', async () => {
    mockRequestResetPassword.mockResolvedValue({ ok: true });

    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_REQUEST_SUBMIT' }));

    await waitFor(() => {
      expect(mockRequestResetPassword).toHaveBeenCalledWith('me@example.com');
    });

    expect(screen.getByText('AUTH_RESET_PASSWORD_REQUEST_SUCCESS')).toBeInTheDocument();
  });

  it('shows an error when the reset request is rejected', async () => {
    mockRequestResetPassword.mockResolvedValue({ ok: false, message: 'Rate limited' });

    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_REQUEST_SUBMIT' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Rate limited');
    });

    expect(screen.queryByText('AUTH_RESET_PASSWORD_REQUEST_SUCCESS')).not.toBeInTheDocument();
  });

  it('returns to login from an emailed reset without cancelling the request', async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('token=live-token'));
    mockVerifyResetPasswordToken.mockResolvedValue(true);

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    const backToLogin = await screen.findByRole('link', { name: 'AUTH_RESET_PASSWORD_BACK_TO_LOGIN' });
    expect(backToLogin).toHaveAttribute('href', '/login');
    expect(screen.queryByText('AUTH_RESET_PASSWORD_CANCEL')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows invalid-link state when verify returns valid:false', async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('token=expired-token'));
    mockVerifyResetPasswordToken.mockResolvedValue(false);

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('AUTH_RESET_PASSWORD_INVALID_LINK')).toBeInTheDocument();
    });
  });
});
