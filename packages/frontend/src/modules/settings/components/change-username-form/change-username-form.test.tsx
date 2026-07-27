import { render } from '@/tests/test-utils';
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

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ChangeUsernameForm', () => {
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

  it('signs the client out after a successful change', () => {
    // Changing the username revokes every session for the user, same as the password
    // form — and the name you sign back in with is the new one.
    render(<ChangeUsernameForm username="old@example.com" />);
    const options = mockUseMutation.mock.calls[0]?.[0] as { onSuccess: () => void };

    options.onSuccess();

    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    expect(reload).toHaveBeenCalled();
  });
});
