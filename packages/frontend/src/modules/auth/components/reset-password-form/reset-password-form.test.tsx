import { render, screen, userEvent } from '@/tests/test-utils';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ResetPasswordForm } from './reset-password-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-tooltip', () => ({
  Tooltip: () => null,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

describe('ResetPasswordForm', () => {
  it('shows the server password rule and refuses a password the server would reject', async () => {
    const onSubmit = vi.fn();
    render(<ResetPasswordForm loading={false} onSubmit={onSubmit} />);

    expect(screen.getByText('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('COMMON_PASSWORD'), 'password1');
    await userEvent.type(screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION'), 'password1');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_SUBMIT' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a password that meets the server rule', async () => {
    const onSubmit = vi.fn();
    render(<ResetPasswordForm loading={false} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('COMMON_PASSWORD'), 'Password1!');
    await userEvent.type(screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION'), 'Password1!');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_RESET_PASSWORD_SUBMIT' }));

    expect(onSubmit).toHaveBeenCalledWith({ password: 'Password1!', passwordConfirm: 'Password1!' });
  });
});
