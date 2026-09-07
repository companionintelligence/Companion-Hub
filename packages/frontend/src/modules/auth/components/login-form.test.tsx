import { render, screen, userEvent } from '@/tests/test-utils';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';

const openAuthInSystemBrowser = vi.fn(async (_url?: string) => {});
vi.mock('@/lib/helpers/open-auth-browser', () => ({
  openAuthInSystemBrowser: (url: string) => openAuthInSystemBrowser(url),
}));

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

    // The toggle carries the name of the field it controls, so forms with more than one
    // password field do not end up with several identically-named buttons.
    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_SHOW_PASSWORD: COMMON_PASSWORD' }));
    expect(passwordInput.type).toBe('text');

    await userEvent.click(screen.getByRole('button', { name: 'APP_INSTALL_FORM_HIDE_PASSWORD: COMMON_PASSWORD' }));
    expect(passwordInput.type).toBe('password');
  });

  it('renders the portal sign-in link with button styling', () => {
    render(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} portalSsoHref="https://portal.example.com" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toHaveClass('h-10', 'w-full', 'font-semibold');
    // This is the <a href> branch — desktop-hub-sso, which signs in IN THE APP —
    // so the hint must be the in-app one, not the "opens in your browser" line
    // that belongs to the mobile flow.
    expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP')).toBeInTheDocument();
    expect(screen.queryByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT')).not.toBeInTheDocument();
  });

  it('shows a personalized portal sign-in label when an account email is known', () => {
    render(
      <MemoryRouter>
        <LoginForm
          loading={false}
          loginType="your local admin account"
          onSubmit={vi.fn()}
          portalSsoHref="https://portal.example.com"
          portalAccountEmail="operator@example.com"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON_AS' })).toBeInTheDocument();
    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toHaveValue('operator@example.com');
  });

  it('opens Companion Account SSO in the system browser so the native webview stays mounted', async () => {
    openAuthInSystemBrowser.mockClear();
    render(
      <MemoryRouter>
        <LoginForm
          loading={false}
          loginType="your local admin account"
          onSubmit={vi.fn()}
          portalSsoHref="http://localhost:5005/api/auth/portal/start?desktop=1"
          openPortalSsoExternally
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' }));

    expect(openAuthInSystemBrowser).toHaveBeenCalledWith('http://localhost:5005/api/auth/portal/start?desktop=1');
    expect(screen.queryByRole('link', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).not.toBeInTheDocument();
  });
});
