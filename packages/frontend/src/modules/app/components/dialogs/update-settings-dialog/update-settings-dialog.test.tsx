import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UpdateSettingsDialog } from './update-settings-dialog';

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateAppConfigMutation: () => ({
    mutationFn: vi.fn(),
  }),
}));

// Renders a real <form> so "is the Hub access section inside the form?" is an honest question —
// a <div> stub would make that assertion pass no matter where the section is mounted.
vi.mock('../../install-form/install-form', () => ({
  InstallForm: ({ onDirtyChange, formId }: { onDirtyChange?: (dirty: boolean) => void; formId: string }) => (
    <form id={formId} data-testid="install-form">
      <button type="button" data-testid="mark-dirty" onClick={() => onDirtyChange?.(true)}>
        Mark dirty
      </button>
      <button type="submit" form={formId}>
        Submit
      </button>
    </form>
  ),
}));

// HubAccess owns its own data fetching (useQuery/useMutation) and is covered by its colocated
// test; here we only care that the dialog mounts it with the right props and in the right place.
vi.mock('../../hub-access/hub-access', () => ({
  HubAccess: ({ appUrn, hasUnsavedChanges }: { appUrn: string; hasUnsavedChanges?: boolean }) => (
    <div data-testid="hub-access-stub" data-urn={appUrn} data-unsaved={String(Boolean(hasUnsavedChanges))} />
  ),
}));

vi.mock('../../install-form-buttons/install-form-buttons', () => ({
  InstallFormButtons: ({ disabled, formId }: { disabled?: boolean; formId: string }) => (
    <button type="submit" form={formId} disabled={disabled} data-testid="update-settings-save-btn">
      Save
    </button>
  ),
}));

const mockInfo = {
  id: 'airtrail',
  urn: 'airtrail:ci-marketplace',
  form_fields: [],
} as any;

describe('UpdateSettingsDialog', () => {
  it('shows restart hint and enables save only after the form is changed', async () => {
    const user = userEvent.setup();

    render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="running" />);

    expect(screen.queryByTestId('update-settings-restart-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('update-settings-save-btn')).toBeDisabled();

    await user.click(screen.getByTestId('mark-dirty'));

    expect(screen.getByTestId('update-settings-restart-hint')).toHaveTextContent(
      'Saving these settings will restart the app with your new configuration.',
    );
    expect(screen.getByTestId('update-settings-save-btn')).not.toBeDisabled();
  });

  it('shows stopped hint when the app is not running', async () => {
    const user = userEvent.setup();

    render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="stopped" />);

    await user.click(screen.getByTestId('mark-dirty'));

    expect(screen.getByTestId('update-settings-restart-hint')).toHaveTextContent('Changes will apply when you next start the app.');
  });

  it('hosts the Hub access section and hands it the unsaved-changes state', async () => {
    const user = userEvent.setup();

    render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="running" />);

    const section = screen.getByTestId('hub-access-stub');
    expect(section).toHaveAttribute('data-urn', mockInfo.urn);
    expect(section).toHaveAttribute('data-unsaved', 'false');

    // Rotating restarts the app, so the section has to know the form is holding edits.
    await user.click(screen.getByTestId('mark-dirty'));
    expect(screen.getByTestId('hub-access-stub')).toHaveAttribute('data-unsaved', 'true');
  });

  it('renders the Hub access section outside the form, so Rotate can never submit settings', () => {
    render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="running" />);

    expect(screen.getByTestId('hub-access-stub').closest('form')).toBeNull();
  });
});
