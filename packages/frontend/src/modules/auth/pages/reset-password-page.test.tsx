import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResetPasswordPage from './reset-password-page';

const { mockApiFetch, mockNavigate, mockSearchParams, toast } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockNavigate: vi.fn(),
  mockSearchParams: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/mock-link">{children}</a>,
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams(), vi.fn()],
}));

vi.mock('react-hot-toast', () => ({
  default: toast,
}));

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.mockReturnValue(new URLSearchParams());
    mockApiFetch.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it('renders email request flow and removes demo credentials copy', () => {
    render(<ResetPasswordPage />);

    expect(screen.queryByText('Demo Account Credentials')).not.toBeInTheDocument();
    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset instructions' })).toBeInTheDocument();
  });

  it('shows generic success message after requesting a reset', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ success: true, message: 'ok' }));

    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset instructions' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/auth/password-reset/request', expect.objectContaining({ method: 'POST' }));
    });

    expect(screen.getByText("If this email is registered, you'll receive reset instructions shortly.")).toBeInTheDocument();
  });

  it('shows an error when the reset request is rejected', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ message: 'Rate limited' }, { status: 429 }));

    render(<ResetPasswordPage />);

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'me@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset instructions' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Rate limited');
    });

    expect(screen.queryByText("If this email is registered, you'll receive reset instructions shortly.")).not.toBeInTheDocument();
  });

  it('shows invalid-link state when verify returns valid:false', async () => {
    mockSearchParams.mockReturnValue(new URLSearchParams('token=expired-token'));
    mockApiFetch.mockResolvedValue(jsonResponse({ valid: false }));

    await act(async () => {
      render(<ResetPasswordPage />);
    });

    await waitFor(() => {
      expect(screen.getByText('This reset link is invalid or expired.')).toBeInTheDocument();
    });
  });
});
