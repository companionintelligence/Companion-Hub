import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const { resetToDefaults, resetsWhenFormRendered } = vi.hoisted(() => ({ resetToDefaults: vi.fn(), resetsWhenFormRendered: [] as number[] }));

vi.mock('@/stores/multiServiceStore', () => ({
  useMultiServiceStore: (selector: (state: { resetToDefaults: typeof resetToDefaults }) => unknown) => selector({ resetToDefaults }),
}));

vi.mock('@/components/multi-service-form/multi-service-form', () => ({
  MultiServiceForm: () => {
    resetsWhenFormRendered.push(resetToDefaults.mock.calls.length);
    return <div />;
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false }),
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

  // The form's environment and volume rows keep what they read on the first render. Rendering it
  // before the reset showed the last edited app's variables and folders in a blank form.
  it('renders the form only after the store has been reset', () => {
    resetToDefaults.mockClear();
    resetsWhenFormRendered.length = 0;

    render(
      <MemoryRouter>
        <CreatePage />
      </MemoryRouter>,
    );

    expect(resetsWhenFormRendered.length).toBeGreaterThan(0);
    expect(resetsWhenFormRendered[0]).toBe(1);
  });
});
