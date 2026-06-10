import { render, screen, userEvent } from '@/tests/test-utils';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: string | Record<string, unknown>) => (typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key),
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

    const passwordInput = screen.getByLabelText('COMMON_PASSWORD') as HTMLInputElement;
    expect(passwordInput.type).toBe('password');

    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_SHOW_PASSWORD' }));
    expect(passwordInput.type).toBe('text');

    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_HIDE_PASSWORD' }));
    expect(passwordInput.type).toBe('password');
  });

  it('renders the portal sign-in link with button styling', () => {
    render(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} portalSsoHref="https://portal.example.com" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Sign in using your Companion Account' })).toHaveClass('h-10', 'w-full', 'font-semibold');
    expect(screen.getByText('Uses your Companion Account.')).toBeInTheDocument();
  });
});
