import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const { mockNavigate, composeCurrent } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  composeCurrent: { value: '{' as string | undefined },
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: () => ({ appId: 'my-app' }),
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: composeCurrent.value ? { current: composeCurrent.value } : undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/components/multi-service-form/multi-service-form', () => ({
  MultiServiceForm: () => <div data-testid="edit-form" />,
}));

vi.mock('@/stores/multiServiceStore', () => ({
  useMultiServiceStore: () => ({ setServices: vi.fn(), resetToDefaults: vi.fn() }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppComposeDiffOptions: () => ({ queryKey: ['compose-diff'] }),
  updateCustomAppMutation: () => ({}),
}));

vi.mock('@/api-client', () => ({
  getAppComposeDiff: vi.fn(),
}));

vi.mock('./+types/custom-app-edit-page', () => ({
  Route: {},
}));

import EditPageContent from './custom-app-edit-page';

function pageProps(loaderData: { composeDiff: { current: string } } | undefined): ComponentProps<typeof EditPageContent> {
  return { loaderData } as ComponentProps<typeof EditPageContent>;
}

describe('custom app edit', () => {
  it('shows the parse error and a way back instead of staying on loading', () => {
    composeCurrent.value = '{';

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps({ composeDiff: { current: '{' } })} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Invalid configuration. Please check your services.')).toBeInTheDocument();
    expect(screen.queryByText('LOADING')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/apps/my-app');
  });

  it('names the loading state while the stored config has not arrived', () => {
    composeCurrent.value = undefined;

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps(undefined)} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('LOADING')).not.toBeInTheDocument();
  });
});
