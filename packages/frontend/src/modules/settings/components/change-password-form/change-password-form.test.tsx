import { render } from '@/tests/test-utils';
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

vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ChangePasswordForm', () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    });
  });

  /** Capture the options the component hands `useMutation` so `onSuccess` can be driven directly. */
  function renderAndCaptureOptions() {
    render(<ChangePasswordForm />);
    return mockUseMutation.mock.calls[0]?.[0] as { onSuccess: () => void };
  }

  it('signs the client out after a successful change', () => {
    // The endpoint revokes every session for the user and clears the cookie. The desktop
    // app authenticates with a localStorage session that `clearCookie` cannot reach, so
    // without this the UI keeps looking signed in until some later request 401s.
    renderAndCaptureOptions().onSuccess();

    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    expect(reload).toHaveBeenCalled();
  });
});
