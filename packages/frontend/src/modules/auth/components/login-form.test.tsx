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
    // This is the <a href> branch — browser-hub-sso, a plain browser already on
    // the Hub, which navigates in place — so the hint must be the in-app one and
    // not the "opens in your browser" line that belongs to the native shells.
    expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT_IN_APP')).toBeInTheDocument();
    expect(screen.queryByText('AUTH_LOGIN_COMPANION_ACCOUNT_HINT')).not.toBeInTheDocument();
    expect(screen.queryByText('AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET')).not.toBeInTheDocument();
  });

  it('explains that Companion Account SSO needs Portal when the Hub is offline', () => {
    render(
      <MemoryRouter>
        <LoginForm
          loading={false}
          loginType="your local admin account"
          onSubmit={vi.fn()}
          portalSsoHref="https://portal.example.com"
          portalReachable={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('AUTH_LOGIN_COMPANION_ACCOUNT_NEEDS_INTERNET')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AUTH_LOGIN_COMPANION_ACCOUNT_BUTTON' })).toBeDisabled();
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

  it('does not overwrite a typed email when the Portal hint resolves late', async () => {
    // The hint is fetched asynchronously, so it can arrive after the operator has
    // started typing. It is a default, not an instruction: clobbering the field here
    // discarded their input and then failed the login with an address they never chose.
    const { rerender } = render(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText('AUTH_FORM_EMAIL'), 'typed@example.com');

    rerender(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} portalAccountEmail="hint@example.com" />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toHaveValue('typed@example.com');
  });

  it('still fills an untouched email field when the Portal hint resolves late', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toHaveValue('');

    rerender(
      <MemoryRouter>
        <LoginForm loading={false} loginType="your local admin account" onSubmit={vi.fn()} portalAccountEmail="hint@example.com" />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('AUTH_FORM_EMAIL')).toHaveValue('hint@example.com');
  });

  it('offers an account switcher when a Portal email is known', async () => {
    const onSwitchAccount = vi.fn();
    render(
      <MemoryRouter>
        <LoginForm
          loading={false}
          loginType="your local admin account"
          onSubmit={vi.fn()}
          portalSsoHref="https://portal.example.com"
          portalAccountEmail="hello@lifescope.io"
          onSwitchAccount={onSwitchAccount}
        />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByTestId('login-switch-account'));
    expect(onSwitchAccount).toHaveBeenCalled();
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
