import { render, screen, userEvent, within } from '@/tests/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeUsernameForm } from './change-username-form';

const { mockUseMutation, clearClientHubState } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  clearClientHubState: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => mockUseMutation(options),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  changeUsernameMutation: vi.fn(() => ({})),
}));

vi.mock('@/lib/clear-client-hub-state', () => ({ clearClientHubState }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type SuccessOptions = { onSuccess: (data: unknown, variables: { body: { newUsername: string; password: string } }) => void };

describe('ChangeUsernameForm', () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
    Object.defineProperty(window, 'location', {
      value: { ...window.location, assign },
      writable: true,
      configurable: true,
    });
  });

  it('says in words that the password is missing when the dialog is sent with nothing typed', async () => {
    const mutate = vi.fn();
    mockUseMutation.mockReturnValue({ mutate, isPending: false });
    render(<ChangeUsernameForm username="old@example.com" />);

    await userEvent.click(screen.getByRole('button', { name: 'COMMON_CHANGE_USERNAME' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_CHANGE_USERNAME' }));

    expect(await within(dialog).findByText('AUTH_FORM_ERROR_PASSWORD_REQUIRED')).toBeInTheDocument();
    // An empty username reads like the sign-in form's empty email, a malformed one like its bad one.
    expect(within(dialog).getByText('AUTH_FORM_ERROR_EMAIL_REQUIRED')).toBeInTheDocument();
    expect(within(dialog).queryByText(/too small|expected string/i)).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByPlaceholderText('SETTINGS_SECURITY_CHANGE_USERNAME_FORM_NEW_USERNAME'), 'owner@localhost');
    await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_CHANGE_USERNAME' }));
    expect(await within(dialog).findByText('SETTINGS_SECURITY_CHANGE_USERNAME_FORM_INVALID_USERNAME')).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('signs the client out after a successful change', () => {
    // Changing the username revokes every session for the user, same as the password
    // form — and the name you sign back in with is the new one.
    render(<ChangeUsernameForm username="old@example.com" />);
    const options = mockUseMutation.mock.calls[0]?.[0] as SuccessOptions;

    options.onSuccess(undefined, { body: { newUsername: 'new@example.com', password: 'pw' } });

    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    expect(assign).toHaveBeenCalledWith('/login?signed_out=username_changed');
  });

  describe('the account the sign-in page offers', () => {
    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem('ci-hub.portalAccountEmail', 'old@example.com');
    });

    afterEach(() => {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('is the new username in the desktop window', () => {
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() };
      render(<ChangeUsernameForm username="old@example.com" />);
      const options = mockUseMutation.mock.calls[0]?.[0] as SuccessOptions;

      options.onSuccess(undefined, { body: { newUsername: 'New@Example.com', password: 'pw' } });

      expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBe('new@example.com');
    });

    it('is left alone in a browser', () => {
      render(<ChangeUsernameForm username="old@example.com" />);
      const options = mockUseMutation.mock.calls[0]?.[0] as SuccessOptions;

      options.onSuccess(undefined, { body: { newUsername: 'new@example.com', password: 'pw' } });

      expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBe('old@example.com');
    });
  });
});
