import { render, screen, userEvent } from '@/tests/test-utils';
import { MemoryRouter } from 'react-router';
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

  it('puts the CI Account sign-in under the title, ahead of the sign-up form', () => {
    render(<RegisterForm loading={false} onSubmit={vi.fn()} portalSignIn={<button type="button">ci account sign-in</button>} />);

    const title = screen.getByRole('heading', { name: 'AUTH_REGISTER_TITLE' });
    const signIn = screen.getByRole('button', { name: 'ci account sign-in' });
    const email = screen.getByLabelText('AUTH_FORM_EMAIL');

    expect(title.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(signIn.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The note sends CI Account holders to the sign-up form, which Portal refuses for their email.
    expect(screen.queryByText('AUTH_REGISTER_NOTE_2')).not.toBeInTheDocument();
  });

  it('links to the sign-in page when given where it is', () => {
    render(
      <MemoryRouter>
        <RegisterForm loading={false} onSubmit={vi.fn()} signInHref="/login?redirect_url=%2Fstore" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'AUTH_REGISTER_SIGN_IN_INSTEAD' })).toHaveAttribute('href', '/login?redirect_url=%2Fstore');
  });

  it('keeps the plain sign-up form without them', () => {
    render(<RegisterForm loading={false} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AUTH_REGISTER_TITLE' }).nextElementSibling).toHaveTextContent('AUTH_REGISTER_NOTE');
    expect(screen.getByText('AUTH_REGISTER_NOTE_2')).toBeInTheDocument();
  });
});
