import { render, screen, userEvent } from '@/tests/test-utils';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-tooltip', () => ({
  Tooltip: () => null,
}));

describe('LoginForm', () => {
  it('toggles the password field visibility', async () => {
    render(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} />
      </MemoryRouter>,
    );

    const passwordInput = screen.getByLabelText('AUTH_FORM_PASSWORD') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_SHOW_PASSWORD' }));
    expect(passwordInput.type).toBe('text');

    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_HIDE_PASSWORD' }));
    expect(passwordInput.type).toBe('password');
  });
});
