import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserSettingsContainer } from './user-settings';

const pending = vi.hoisted(() => ({ settings: false, mode: false, modeMutate: vi.fn() }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateUserSettingsMutation: () => ({ mutationKey: ['settings'] }),
  updateAdvancedModeMutation: () => ({ mutationKey: ['mode'] }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { mutationKey?: string[] }) =>
    options.mutationKey?.[0] === 'mode' ? { mutate: pending.modeMutate, isPending: pending.mode } : { mutate: vi.fn(), isPending: pending.settings },
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ refreshAppContext: vi.fn(), user: { advancedMode: false } }),
}));

vi.mock('../components/user-settings-form/user-settings-form', () => ({
  UserSettingsForm: ({ loading }: { loading?: boolean }) => (
    <button type="submit" disabled={loading}>
      Update settings
    </button>
  ),
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
});
