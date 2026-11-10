import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

// The form's Radix controls measure themselves. jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  createCustomAppMutation: () => ({}),
}));

import CreatePage from './custom-app-create-page';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

describe('custom app create after editing an app', () => {
  it('shows none of the edited app rows and adds a row of its own', () => {
    // What the edit page leaves in the shared store.
    useMultiServiceStore.setState({
      services: [
        {
          _id: 'edited-app',
          name: 'edited',
          image: 'edited:1',
          isMain: true,
          internalPort: 8080,
          environment: [{ key: 'FOO', value: 'bar' }],
          volumes: [{ hostPath: '/tmp/ci-test', containerPath: '/data' }],
          addPorts: [{ hostPort: 18080, containerPort: 8081 }],
        },
      ],
    });

    render(
      <MemoryRouter>
        <CreatePage />
      </MemoryRouter>,
    );

    expect(screen.getByDisplayValue('nginx:alpine')).toBeInTheDocument();
    for (const leftover of ['FOO', 'bar', '/tmp/ci-test', '/data', '18080', '8081']) {
      expect(screen.queryByDisplayValue(leftover)).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Add variable', hidden: true }));

    expect(screen.getAllByPlaceholderText('KEY')).toHaveLength(1);
    expect(screen.getByPlaceholderText('KEY')).toHaveValue('');
  });
});
