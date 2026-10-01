import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UninstallDialog } from './uninstall-dialog';

// Capture the mutate spy + useMutation options, and drive the force-gate per test.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  opts: undefined as undefined | Record<string, (arg?: unknown) => void>,
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

// Mock the gate but keep a real forceConfirmed state so the switch toggle is exercised.
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

const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: vi.fn() },
}));

const normalApp = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as never;
const providerApp = { id: 'ci-memory', name: 'CI Memory', urn: 'ci-memory:ci-marketplace' } as never;

const DATA_LOST = 'All data for this app will be lost.';
const DATA_KEPT = "This app's data and backups stay on this Hub.";

describe('UninstallDialog', () => {
  beforeEach(() => {
    h.mutate.mockReset();
    h.invalidateAppQueries.mockReset();
    mockToastError.mockReset();
    h.opts = undefined;
    h.gate = { requiresForce: false, consumers: [], unableToVerify: false, submitDisabledBase: false };
  });

  it('uninstalls a normal app without a provider warning and force: false', async () => {
    const user = userEvent.setup();
    render(<UninstallDialog info={normalApp} isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/connected to CI Memory/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: { deleteAllData: true, force: false } });
  });

  it('asks "Uninstall <name>?" with no space before the question mark', () => {
    render(<UninstallDialog info={normalApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Uninstall Plane?' })).toBeInTheDocument();
  });

  it('says the data will be lost while Delete all data is on', () => {
    render(<UninstallDialog info={normalApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('switch', { name: 'Delete all data' })).toBeChecked();
    expect(screen.getByText(DATA_LOST)).toBeInTheDocument();
    expect(screen.queryByText(DATA_KEPT)).not.toBeInTheDocument();
  });

  it('says the data will be kept once Delete all data is off, and uninstalls without deleting it', async () => {
    const user = userEvent.setup();
    render(<UninstallDialog info={normalApp} isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('switch', { name: 'Delete all data' }));

    expect(screen.getByText(DATA_KEPT)).toBeInTheDocument();
    expect(screen.queryByText(DATA_LOST)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: { deleteAllData: false, force: false } });
  });

  it('lists connected consumers and gates the provider uninstall behind the force switch', async () => {
    h.gate = {
      requiresForce: true,
      consumers: [{ appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' }],
      unableToVerify: false,
      submitDisabledBase: false,
    };
    const user = userEvent.setup();
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/still connected to CI Memory/)).toBeInTheDocument();
    expect(screen.getByText('Hermes')).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Uninstall' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'I understand — disconnect these apps and proceed' }));
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { deleteAllData: true, force: true } });
  });

  it('shows a generic warning and still gates when the consumer list could not be verified', async () => {
    h.gate = { requiresForce: true, consumers: [], unableToVerify: true, submitDisabledBase: false };
    const user = userEvent.setup();
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/Couldn't check which apps are connected/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Uninstall' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('switch', { name: 'I understand — disconnect these apps and proceed' }));
    await user.click(submit);
    expect(h.mutate).toHaveBeenCalledWith({ path: { urn: 'ci-memory:ci-marketplace' }, body: { deleteAllData: true, force: true } });
  });

  it('treats the provider like a normal app when no consumers are connected', async () => {
    h.gate = { requiresForce: false, consumers: [], unableToVerify: false, submitDisabledBase: false };
    const user = userEvent.setup();
    render(<UninstallDialog info={providerApp} isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/connected to CI Memory/)).not.toBeInTheDocument();

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
