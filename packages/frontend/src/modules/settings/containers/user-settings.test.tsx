import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from '@/lib/helpers/open-external';
import { UserSettingsContainer } from './user-settings';

const pending = vi.hoisted(() => ({ settings: false, mode: false, modeMutate: vi.fn(), formValues: vi.fn() }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getPortalConfigOptions: () => ({ queryKey: ['portal-config'] }),
  updateUserSettingsMutation: () => ({ mutationKey: ['settings'] }),
  updateAdvancedModeMutation: () => ({ mutationKey: ['mode'] }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { portalUrl: 'https://portal.example.com' } }),
  useMutation: (options: { mutationKey?: string[] }) =>
    options.mutationKey?.[0] === 'mode' ? { mutate: pending.modeMutate, isPending: pending.mode } : { mutate: vi.fn(), isPending: pending.settings },
}));

vi.mock('@/lib/helpers/open-external', () => ({ openExternal: vi.fn().mockResolvedValue(true) }));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ refreshAppContext: vi.fn(), user: { advancedMode: false } }),
}));

// Its own test covers it (guest-dashboard-settings.test.tsx); here it would need the whole query client.
vi.mock('./guest-dashboard-settings', () => ({
  GuestDashboardSettings: () => <div data-testid="guest-dashboard-settings" />,
}));

vi.mock('../components/user-settings-form/user-settings-form', () => ({
  UserSettingsForm: ({ loading, initialValues }: { loading?: boolean; initialValues?: unknown }) => {
    pending.formValues(initialValues);
    return (
      <button type="submit" disabled={loading}>
        Update settings
      </button>
    );
  },
}));

describe('UserSettingsContainer pending state', () => {
  beforeEach(() => {
    pending.settings = false;
    pending.mode = false;
    pending.modeMutate.mockClear();
  });

  it('disables Update settings while the save is in flight', () => {
    pending.settings = true;
    render(<UserSettingsContainer />);
    expect(screen.getByRole('button', { name: 'Update settings' })).toBeDisabled();
  });

  it('shows the Advanced Mode choice and disables the switch until the server answers', () => {
    const { rerender } = render(<UserSettingsContainer />);
    fireEvent.click(screen.getByRole('switch'));
    expect(pending.modeMutate).toHaveBeenCalledWith({ body: { advancedMode: true } });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    pending.mode = true;
    rerender(<UserSettingsContainer />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('opens the Companion Portal account deletion settings and privacy policy', () => {
    render(<UserSettingsContainer />);

    fireEvent.click(screen.getByRole('button', { name: /manage or delete account/i }));
    expect(openExternal).toHaveBeenCalledWith('https://portal.example.com/user-settings');

    fireEvent.click(screen.getByRole('button', { name: /privacy policy/i }));
    expect(openExternal).toHaveBeenCalledWith('https://ci.computer/privacy-policy');
  });

  // #2422: the guest dashboard's own card, for someone who may change the Hub's settings.
  it('shows the guest dashboard card to a manager and not to a member', () => {
    const { rerender } = render(<UserSettingsContainer manageHub />);
    expect(screen.getByTestId('guest-dashboard-settings')).toBeInTheDocument();

    rerender(<UserSettingsContainer manageHub={false} />);
    expect(screen.queryByTestId('guest-dashboard-settings')).not.toBeInTheDocument();
  });

  // The card's switch refreshes the Hub's settings. Handed to General settings, the new value reset that
  // form and dropped what was typed there and not saved yet.
  it('keeps the guest dashboard switch out of the General settings form', () => {
    render(<UserSettingsContainer initialValues={{ domain: 'example.com', guestDashboard: true } as never} />);

    expect(pending.formValues).toHaveBeenLastCalledWith({ domain: 'example.com' });
  });
});
