import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UninstallDialog } from './uninstall-dialog';

// Capture the mutate spy and the options passed to useMutation so we can exercise onError.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as undefined | Record<string, (arg?: unknown) => void>,
  invalidateAppQueries: vi.fn(),
  consumers: { data: [] as Array<{ appUrn: string; name: string }>, isLoading: false },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: Record<string, (arg?: unknown) => void>) => {
    h.opts = opts;
    return { mutate: h.mutate, isPending: false };
  },
  useQueryClient: () => ({}),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  uninstallAppMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus: vi.fn() }),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: (...args: unknown[]) => h.invalidateAppQueries(...args),
}));

vi.mock('@/modules/app/helpers/use-memory-connection', () => ({
  useMemoryConsumers: () => h.consumers,
}));

const mockToastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() },
}));

const normalApp = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;
const providerApp = { id: 'ci-memory', name: 'Companion Memory', urn: 'ci-memory:ci-marketplace' } as never;

describe('UninstallDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.invalidateAppQueries.mockReset();
    mockToastError.mockReset();
    h.opts = undefined;
    h.consumers = { data: [], isLoading: false };
  });

  it('uninstalls a normal app without a provider warning and force: false', async () => {
    const user = userEvent.setup();
    render(<UninstallDialog info={normalApp} isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/still connected to Companion Memory/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: { deleteAllData: true, force: false } });
  });

  it('lists connected consumers and gates the provider uninstall behind the force switch', async () => {
    h.consumers = { data: [{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }], isLoading: false };
    const user = userEvent.setup();
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/still connected to Companion Memory/)).toBeInTheDocument();
    expect(screen.getByText('Hermes')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Uninstall' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'uninstall-force-confirm' }));
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { deleteAllData: true, force: true } });
  });

  it('treats the provider like a normal app when no consumers are connected', async () => {
    h.consumers = { data: [], isLoading: false };
    const user = userEvent.setup();
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/still connected to Companion Memory/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { deleteAllData: true, force: false } });
  });

  it('toasts and re-syncs the app on a failed uninstall so the status never sticks on "uninstalling"', () => {
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    h.opts?.onError?.({ message: 'APP_ERROR_MEMORY_PROVIDER_IN_USE', intlParams: { count: '1', apps: 'Hermes' } } as never);

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(h.invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'ci-memory:ci-marketplace');
  });
});
