import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetDialog } from './reset-dialog';

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidateAppQueries: vi.fn(),
  gate: {
    requiresForce: false,
    consumers: [] as Array<{ appUrn: string; name: string }>,
    unableToVerify: false,
    submitDisabledBase: false,
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: Record<string, (arg?: unknown) => void>) => {
    void opts;
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

vi.mock('@/modules/app/helpers/use-memory-connection', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    useMemoryProviderForceGate: () => {
      const [forceConfirmed, setForceConfirmed] = react.useState(false);
      return {
        requiresForce: h.gate.requiresForce,
        consumers: h.gate.consumers,
        unableToVerify: h.gate.unableToVerify,
        forceConfirmed,
        setForceConfirmed,
        submitDisabled: h.gate.submitDisabledBase || (h.gate.requiresForce && !forceConfirmed),
      };
    },
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const normalApp = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;
const providerApp = { id: 'ci-memory', name: 'CI Memory', urn: 'ci-memory:ci-marketplace' } as never;

describe('ResetDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.gate = { requiresForce: false, consumers: [], unableToVerify: false, submitDisabledBase: false };
  });

  it('resets a normal app immediately with force: false', async () => {
    const user = userEvent.setup();
    render(<ResetDialog info={normalApp} isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: { force: false } });
  });

  it('gates the provider reset behind the force switch and sends force: true', async () => {
    h.gate = {
      requiresForce: true,
      consumers: [{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }],
      unableToVerify: false,
      submitDisabledBase: false,
    };
    const user = userEvent.setup();
    render(<ResetDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByText('Hermes')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Reset' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'I understand — disconnect these apps and proceed' }));
    await user.click(submit);
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { force: true } });
  });
});
