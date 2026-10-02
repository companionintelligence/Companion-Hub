import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const { resetToDefaults } = vi.hoisted(() => ({ resetToDefaults: vi.fn() }));

vi.mock('@/stores/multiServiceStore', () => ({
  useMultiServiceStore: (selector: (state: { resetToDefaults: typeof resetToDefaults }) => unknown) => selector({ resetToDefaults }),
}));

vi.mock('@/components/multi-service-form/multi-service-form', () => ({
  MultiServiceForm: () => <div />,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  createCustomAppMutation: () => ({}),
}));

import CreatePage from './custom-app-create-page';

describe('custom app create', () => {
  it('starts from a blank app instead of the last one that was edited', () => {
    render(
      <MemoryRouter>
        <CreatePage />
      </MemoryRouter>,
    );

    expect(resetToDefaults).toHaveBeenCalledOnce();
  });
});
