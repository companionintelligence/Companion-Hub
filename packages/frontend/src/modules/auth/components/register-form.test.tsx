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

    const passwordInput = screen.getByLabelText('AUTH_FORM_PASSWORD') as HTMLInputElement;
    const confirmationInput = screen.getByLabelText('AUTH_FORM_PASSWORD_CONFIRMATION') as HTMLInputElement;
    const toggles = screen.getAllByRole('button', { name: 'APP_INSTALL_FORM_SHOW_PASSWORD' });
    const passwordToggle = toggles[0] as HTMLElement;
    const confirmationToggle = toggles[1] as HTMLElement;

    expect(passwordInput.type).toBe('password');
    expect(confirmationInput.type).toBe('password');

    await userEvent.click(passwordToggle);
    expect(passwordInput.type).toBe('text');
    expect(confirmationInput.type).toBe('password');

    await userEvent.click(confirmationToggle);
    expect(passwordInput.type).toBe('text');
    expect(confirmationInput.type).toBe('text');
  });
});
