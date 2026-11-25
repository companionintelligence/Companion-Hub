import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateSettingsDialog } from './update-settings-dialog';

// The options the dialog handed useMutation, so a test can land or fail the save itself.
type MutationOptions = {
  onMutate?: (variables: unknown) => void;
  onSuccess?: () => Promise<void> | void;
  onError?: (e: { message: string }) => void;
};
const mutation = vi.hoisted(() => ({
  options: undefined as MutationOptions | undefined,
  mutate: vi.fn(),
  isPending: false,
  invalidateQueries: vi.fn(async () => undefined),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: (options: MutationOptions) => {
      mutation.options = options;
      // Like the real one, `mutate` runs `onMutate` at once, before the request answers.
      return {
        mutate: (variables: unknown) => {
          mutation.mutate(variables);
          options.onMutate?.(variables);
        },
        isPending: mutation.isPending,
      };
    },
    useQueryClient: () => ({ invalidateQueries: mutation.invalidateQueries }),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateAppConfigMutation: () => ({
    mutationFn: vi.fn(),
  }),
  getAppQueryKey: (options: unknown) => ['getApp', options],
}));

// Renders a real <form> so "is the Hub access section inside the form?" is an honest question —
// a <div> stub would make that assertion pass no matter where the section is mounted.
vi.mock('../../install-form/install-form', () => ({
  InstallForm: ({
    onDirtyChange,
    onSubmittingChange,
    onSubmit,
    formId,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
    onSubmittingChange?: (submitting: boolean) => void;
    onSubmit: (values: Record<string, unknown>) => void;
    formId: string;
  }) => (
    <form
      id={formId}
      data-testid="install-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ publicPaths: ['/hook'] });
      }}
    >
      <button type="button" data-testid="mark-dirty" onClick={() => onDirtyChange?.(true)}>
        Mark dirty
      </button>
      <button type="button" data-testid="start-submit" onClick={() => onSubmittingChange?.(true)}>
        Start submitting
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
  InstallFormButtons: ({ disabled, loading, formId }: { disabled?: boolean; loading?: boolean; formId: string }) => (
    <button type="submit" form={formId} disabled={disabled} aria-busy={loading || undefined} data-testid="update-settings-save-btn">
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
  beforeEach(() => {
    vi.clearAllMocks();
    mutation.options = undefined;
    mutation.isPending = false;
  });

  describe('saving', () => {
    const submit = async (onClose = vi.fn()) => {
      const user = userEvent.setup();
      render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={onClose} status="running" />);
      await user.click(screen.getByTestId('mark-dirty'));
      await user.click(screen.getByTestId('update-settings-save-btn'));
      return onClose;
    };

    // It once closed on the click, and the Hub took ~11 s to answer: nothing on screen, and settings
    // reopened in that time showed the old values.
    it('stays open after Update is clicked, until the save lands', async () => {
      const onClose = await submit();

      expect(mutation.mutate).toHaveBeenCalledWith({ path: { urn: mockInfo.urn }, body: expect.objectContaining({ publicPaths: ['/hook'] }) });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows Update busy while the save is in flight', () => {
      mutation.isPending = true;
      render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="running" />);

      expect(screen.getByTestId('update-settings-save-btn')).toHaveAttribute('aria-busy', 'true');
    });

    it('reads the app again, then says so and closes, once the save lands', async () => {
      const order: string[] = [];
      mutation.invalidateQueries.mockImplementationOnce(async () => {
        order.push('refetched');
      });
      vi.mocked(toast.success).mockImplementationOnce(() => {
        order.push('toast');
        return '';
      });
      const onClose = await submit(vi.fn(() => order.push('closed')));

      await act(async () => {
        await mutation.options?.onSuccess?.();
      });

      expect(mutation.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['getApp', { path: { urn: mockInfo.urn } }] });
      expect(order).toEqual(['refetched', 'toast', 'closed']);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps the edits open to retry when the save fails', async () => {
      const onClose = await submit();

      act(() => mutation.options?.onError?.({ message: 'APP_ERROR_APP_FAILED_TO_UPDATE' }));

      expect(toast.error).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('install-form')).toBeInTheDocument();
    });
  });

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

  // On Public Web the form runs a last DNS check before it saves, which took seconds on a slow link.
  it('shows Update busy while the form is still checking, before the save goes out', async () => {
    const user = userEvent.setup();

    render(<UpdateSettingsDialog info={mockInfo} config={{}} isOpen onClose={vi.fn()} status="running" />);

    expect(screen.getByTestId('update-settings-save-btn')).not.toHaveAttribute('aria-busy');

    await user.click(screen.getByTestId('start-submit'));

    expect(screen.getByTestId('update-settings-save-btn')).toHaveAttribute('aria-busy', 'true');
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
