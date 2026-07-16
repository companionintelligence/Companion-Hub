import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetDialog } from './reset-dialog';

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
  resetAppMutation: () => ({ mutationFn: vi.fn() }),
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

vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const normalApp = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;
const providerApp = { id: 'ci-memory', name: 'Companion Memory', urn: 'ci-memory:ci-marketplace' } as never;

describe('ResetDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.consumers = { data: [], isLoading: false };
  });

  it('resets a normal app immediately with force: false', async () => {
    const user = userEvent.setup();
    render(<ResetDialog info={normalApp} isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: { force: false } });
  });

  it('gates the provider reset behind the force switch and sends force: true', async () => {
    h.consumers = { data: [{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }], isLoading: false };
    const user = userEvent.setup();
    render(<ResetDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByText('Hermes')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Reset' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'reset-force-confirm' }));
    await user.click(submit);
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { force: true } });
  });
});
