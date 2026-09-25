import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartDialog } from './restart-dialog';

// Capture the mutate spy + useMutation options so onError can be driven directly.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as undefined | Record<string, (arg?: unknown) => void>,
  invalidateAppQueries: vi.fn(),
  toastError: vi.fn(),
  // Stable sentinel: lets the assertion prove the hook's client was forwarded.
  // Distinguishing property: toHaveBeenCalledWith is a DEEP compare, so an empty
  // sentinel would match any empty object and could not detect a wrong client.
  queryClient: { __isQueryClientFromHook: true },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: Record<string, (arg?: unknown) => void>) => {
    h.opts = opts;
    return { mutate: h.mutate, isPending: false };
  },
  useQueryClient: () => h.queryClient,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  restartAppMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: (...args: unknown[]) => h.invalidateAppQueries(...args),
}));

vi.mock('react-hot-toast', () => ({ default: { error: (...args: unknown[]) => h.toastError(...args), success: vi.fn() } }));

const app = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;

describe('RestartDialog', () => {
  beforeEach(() => {
    h.opts = undefined;
    h.mutate.mockReset();
    h.invalidateAppQueries.mockReset();
    h.toastError.mockReset();
  });

  it('restarts the app', async () => {
    const user = userEvent.setup();
    render(<RestartDialog info={app} isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Restart' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' } });
  });

  it('says why the restart is being offered, above the usual line', () => {
    // The custom-domain banner opens this same dialog, so the person confirming
    // sees what the restart is for rather than a bare "Restart Plane?".
    render(<RestartDialog info={app} isOpen onClose={vi.fn()} reason="Restarting Plane lets it answer on plane.acme.com." />);

    const reason = screen.getByText('Restarting Plane lets it answer on plane.acme.com.');
    const usual = screen.getByText('All data will be retained');
    expect(reason.compareDocumentPosition(usual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps its usual wording when there is no reason to give', () => {
    render(<RestartDialog info={app} isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveTextContent('All data will be retained');
    expect(screen.queryByText(/answer on/)).not.toBeInTheDocument();
  });

  it('toasts and re-syncs the app on a failed restart so the status never sticks on "restarting" (#909)', () => {
    render(<RestartDialog info={app} isOpen onClose={vi.fn()} />);

    // A synchronous/pre-flight failure emits no lifecycle SSE event, so the optimistic
    // 'restarting' status is only cleared by re-syncing the app queries.
    h.opts?.onError?.({ message: 'APP_ERROR_APP_NOT_FOUND', intlParams: { id: 'plane' } } as never);

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.invalidateAppQueries).toHaveBeenCalledWith(h.queryClient, 'plane:ci-marketplace');
  });
});
