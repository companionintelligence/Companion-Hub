import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { query, mutateAsync } = vi.hoisted(() => ({
  // One object per answer, as react-query keeps an unchanged answer's identity.
  query: { data: undefined as { current: string } | undefined },
  mutateAsync: vi.fn(async () => undefined),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: () => ({ appId: 'my-app' }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: query.data }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppComposeDiffOptions: () => ({ queryKey: ['compose-diff'] }),
  getAppComposeDiffQueryKey: () => ['compose-diff'],
  getAppQueryKey: () => ['app'],
  // The page reads the app's display name for its title.
  getAppOptions: () => ({ queryKey: ['app'] }),
  updateCustomAppMutation: () => ({}),
}));

vi.mock('@/api-client', () => ({
  getAppComposeDiff: vi.fn(),
}));

import EditPageContent from '../custom-app-edit-page';
import { useMultiServiceStore } from '@/stores/multiServiceStore';

type Environment = { key: string; value: string | number | boolean }[];

function answer(environment: Environment = []) {
  return {
    current: JSON.stringify({ schemaVersion: 2, services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80, environment }] }),
  };
}

function page() {
  const props = { loaderData: { composeDiff: query.data } } as ComponentProps<typeof EditPageContent>;
  return (
    <MemoryRouter>
      <EditPageContent {...props} />
    </MemoryRouter>
  );
}

function keysShown() {
  return screen.getAllByPlaceholderText('KEY').map((input) => (input as HTMLInputElement).value);
}

describe('custom app edit with the real form', () => {
  beforeEach(() => {
    useMultiServiceStore.getState().resetToDefaults();
    mutateAsync.mockClear();
  });

  // The create page and the editor share the store. The third service picked there was still the
  // selected one here, where only one exists, so the editor showed no tabs and no form.
  it('opens on the first service when another page left a later one selected', () => {
    useMultiServiceStore.setState({ activeService: 2 });
    query.data = answer();

    render(page());

    expect(screen.getByRole('button', { name: 'Essentials' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('alpine:3.20').closest('.hidden')).toBeNull();
  });

  // A refetch put the new services into the form's values, but the rows already drawn stayed as they
  // were: one row showed while two were saved.
  it('shows every row of a config read again while the page is open', () => {
    query.data = answer([{ key: 'FOO', value: 'bar' }]);
    const { rerender } = render(page());
    expect(keysShown()).toEqual(['FOO']);

    query.data = answer([
      { key: 'NEW', value: 'one' },
      { key: 'SECOND', value: 'two' },
    ]);
    rerender(page());
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));

    expect(keysShown()).toEqual(['NEW', 'SECOND']);
  });

  // The schema takes a number or a boolean as a value. The fields trimmed every value as a string.
  it('opens a number and a boolean value and saves them as they were', async () => {
    query.data = answer([
      { key: 'N', value: 5 },
      { key: 'B', value: false },
    ]);

    render(page());

    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    expect(screen.getByDisplayValue('false')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          config: expect.objectContaining({
            services: [
              expect.objectContaining({
                environment: [
                  { key: 'N', value: 5 },
                  { key: 'B', value: false },
                ],
              }),
            ],
          }),
        },
      }),
    );
  });
});
