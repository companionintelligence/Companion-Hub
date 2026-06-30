import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CancelInstallDialog } from './cancel-install-dialog';

// Capture the mutate spy so we can assert the cancel call's arguments.
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: () => ({ mutate, isPending: false }),
  };
});

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  cancelOperationMutation: () => ({ mutationFn: vi.fn() }),
}));

const info = { id: 'plane', name: 'Plane', urn: 'plane:ci-marketplace' } as any;

describe('CancelInstallDialog', () => {
  it('renders the cancel-install confirmation (not destructive uninstall copy)', () => {
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} />);
    expect(screen.getByText('Cancel installing Plane?')).toBeInTheDocument();
  });

  it('confirming fires the cancel mutation with the app urn and an empty body', async () => {
    const user = userEvent.setup();
    render(<CancelInstallDialog info={info} isOpen onClose={vi.fn()} onCancelStart={vi.fn()} />);

    await user.click(screen.getByText('Cancel install'));

    expect(mutate).toHaveBeenCalledWith({ path: { urn: 'plane:ci-marketplace' }, body: {} });
  });
});
