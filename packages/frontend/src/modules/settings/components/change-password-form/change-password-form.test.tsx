import { render, screen, userEvent } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangePasswordForm } from './change-password-form';

const { mockUseMutation, clearClientHubState } = vi.hoisted(() => ({
  mockUseMutation: vi.fn(),
  clearClientHubState: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => mockUseMutation(options),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  changePasswordMutation: vi.fn(() => ({})),
}));

vi.mock('@/lib/clear-client-hub-state', () => ({ clearClientHubState }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ChangePasswordForm', () => {
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

  /** Capture the options the component hands `useMutation` so `onSuccess` can be driven directly. */
  function renderAndCaptureOptions() {
    render(<ChangePasswordForm />);
    return mockUseMutation.mock.calls[0]?.[0] as { onSuccess: () => void };
  }

  it('says in words which fields are missing when Change password is clicked with nothing typed', async () => {
    const mutate = vi.fn();
    mockUseMutation.mockReturnValue({ mutate, isPending: false });
    render(<ChangePasswordForm />);

    await userEvent.click(screen.getByRole('button', { name: 'COMMON_CHANGE_PASSWORD' }));

    expect(await screen.findByText('AUTH_FORM_ERROR_PASSWORD_REQUIRED')).toBeInTheDocument();
    expect(screen.getAllByText('COMMON_PASSWORD_MIN_LENGTH')).toHaveLength(2);
    // Zod's own wording ("Too small: expected string to have >=1 characters") is for developers.
    expect(screen.queryByText(/too small|expected string/i)).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('signs the client out after a successful change', () => {
    // The endpoint revokes every session for the user and clears the cookie. The desktop
    // app authenticates with a localStorage session that `clearCookie` cannot reach, so
    // without this the UI keeps looking signed in until some later request 401s.
    renderAndCaptureOptions().onSuccess();

    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    expect(assign).toHaveBeenCalledWith('/login?signed_out=password_changed');
  });
});
