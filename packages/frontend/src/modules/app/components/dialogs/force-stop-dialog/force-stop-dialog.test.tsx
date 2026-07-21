import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForceStopDialog } from './force-stop-dialog';

// Capture the mutate spy + useMutation options so onError can be driven directly.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as undefined | Record<string, (arg?: unknown) => void>,
  invalidateAppQueries: vi.fn(),
  toastError: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: Record<string, (arg?: unknown) => void>) => {
    h.opts = opts;
    return { mutate: h.mutate, isPending: false };
  },
  useQueryClient: () => ({}),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: { post: (...args: unknown[]) => h.post(...args) },
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: (...args: unknown[]) => h.invalidateAppQueries(...args),
}));

vi.mock('react-hot-toast', () => ({ default: { error: (...args: unknown[]) => h.toastError(...args), success: vi.fn() } }));

const app = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;

describe('ForceStopDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.invalidateAppQueries.mockReset();
    h.toastError.mockReset();
  });

  it('force-stops the app', async () => {
    const user = userEvent.setup();
    render(<ForceStopDialog info={app} isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Force Stop' }));
    expect(h.mutate).toHaveBeenCalled();
  });

  it('toasts and re-syncs the app on a failed force-stop so the status never sticks on "stopping" (#909)', () => {
    render(<ForceStopDialog info={app} isOpen onClose={vi.fn()} />);

    // This dialog posts directly via the raw client rather than a generated mutation,
    // so a synchronous/pre-flight rejection is especially plausible — and it emits no
    // lifecycle SSE event to clear the optimistic 'stopping' status.
    h.opts?.onError?.({ message: 'APP_ERROR_APP_NOT_FOUND', intlParams: { id: 'plane' } } as never);

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'plane:ci-marketplace');
  });
});
