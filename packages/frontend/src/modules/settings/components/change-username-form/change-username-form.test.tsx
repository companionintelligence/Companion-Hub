import { render, screen, userEvent, within } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    const options = mockUseMutation.mock.calls[0]?.[0] as { onSuccess: () => void };

    options.onSuccess();

    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    expect(assign).toHaveBeenCalledWith('/login?signed_out=username_changed');
  });
});
