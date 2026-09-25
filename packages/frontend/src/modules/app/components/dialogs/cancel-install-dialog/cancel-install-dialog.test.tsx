import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CancelInstallDialog } from './cancel-install-dialog';

// Capture the mutate spy and the options passed to useMutation so we can exercise onSuccess/onError.
const h = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, opts: undefined as undefined | Record<string, (arg?: unknown) => void> }));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: (opts: Record<string, (arg?: unknown) => void>) => {
      h.opts = opts;
      return { mutate: h.mutate, isPending: h.isPending };
    },
  };
});

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  cancelOperationMutation: () => ({ mutationFn: vi.fn() }),
}));

const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() },
}));

const info = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;

describe('CancelInstallDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.isPending = false;
    mockToastError.mockReset();
  });

  it('renders the cancel-install confirmation (not destructive uninstall copy)', () => {
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} />);
    expect(screen.getByText('Cancel installing Plane?')).toBeInTheDocument();
  });

  it('confirming fires the cancel mutation with the app urn and an empty body', async () => {
    const user = userEvent.setup();
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} onCancelStart={vi.fn()} />);

    await user.click(screen.getByText('Cancel install'));

    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: {} });
  });

  it('enters the optimistic "cancelling" state only when the server accepts the cancel', () => {
    const onCancelStart = vi.fn();
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} onCancelStart={onCancelStart} />);

    h.opts?.onSuccess?.({ outcome: 'cancelling' });
    expect(onCancelStart).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('does NOT enter the cancelling state and toasts when the server refuses the cancel', () => {
    const onCancelStart = vi.fn();
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} onCancelStart={onCancelStart} />);

    h.opts?.onSuccess?.({ outcome: 'refused' });
    expect(onCancelStart).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm button while the cancel request is pending (prevents double-submit)', async () => {
    h.isPending = true;
    const user = userEvent.setup();
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} />);

    const confirm = screen.getByRole('button', { name: 'Cancel install' });
    expect(confirm).toBeDisabled();

    await user.click(confirm);
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
