import { render, screen, userEvent } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { RegisterForm } from './register-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-tooltip', () => ({
  Tooltip: () => null,
}));

describe('RegisterForm', () => {
  it('toggles each password field independently', async () => {
    render(<RegisterForm loading={false} onSubmit={vi.fn()} />);

    const passwordInput = screen.getByLabelText('COMMON_PASSWORD') as HTMLInputElement;
    const confirmationInput = screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION') as HTMLInputElement;
    // Each toggle is named after its own field, so they are picked by name rather than by
    // position — the pair used to be distinguishable only by DOM order.
    const passwordToggle = screen.getByRole('button', { name: 'APP_INSTALL_FORM_SHOW_PASSWORD: COMMON_PASSWORD' });
    const confirmationToggle = screen.getByRole('button', {
      name: 'APP_INSTALL_FORM_SHOW_PASSWORD: AUTH_FORM_PASSWORD_CONFIRMATION',
    });

    expect(passwordInput.type).toBe('password');
    expect(confirmationInput.type).toBe('password');

    await userEvent.click(passwordToggle);
    expect(passwordInput.type).toBe('text');
    expect(confirmationInput.type).toBe('password');

    await userEvent.click(confirmationToggle);
    expect(passwordInput.type).toBe('text');
    expect(confirmationInput.type).toBe('text');
  });

  it('shows the server password rule and refuses a password the server would reject', async () => {
    const onSubmit = vi.fn();
    render(<RegisterForm loading={false} onSubmit={onSubmit} />);

    expect(screen.getByText('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'owner@example.test');
    await userEvent.type(screen.getByLabelText('COMMON_PASSWORD'), 'password1');
    await userEvent.type(screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION'), 'password1');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_REGISTER_SUBMIT' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY').length).toBeGreaterThan(1);
  });

  it('submits a password that meets the server rule', async () => {
    const onSubmit = vi.fn();
    render(<RegisterForm loading={false} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'owner@example.test');
    await userEvent.type(screen.getByLabelText('COMMON_PASSWORD'), 'Password1!');
    await userEvent.type(screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION'), 'Password1!');
    await userEvent.click(screen.getByRole('button', { name: 'AUTH_REGISTER_SUBMIT' }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: 'owner@example.test',
      password: 'Password1!',
      passwordConfirm: 'Password1!',
    });
  });
});
