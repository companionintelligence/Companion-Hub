import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const { mockNavigate, composeCurrent, mutationOptions, toastError, invalidateQueries } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  composeCurrent: { value: '{' as string | undefined },
  mutationOptions: {
    current: undefined as { onError?: (error: { message: string; intlParams?: Record<string, string> }) => void; onSuccess?: () => void } | undefined,
  },
  toastError: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn() },
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
  useMutation: (options: typeof mutationOptions.current) => {
    mutationOptions.current = options;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/components/multi-service-form/multi-service-form', () => ({
  MultiServiceForm: () => <div data-testid="edit-form" />,
}));

vi.mock('@/stores/multiServiceStore', () => ({
  useMultiServiceStore: () => ({ setServices: vi.fn(), resetToDefaults: vi.fn() }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppComposeDiffOptions: () => ({ queryKey: ['compose-diff'] }),
  getAppComposeDiffQueryKey: (options: { path: { urn: string } }) => ['compose-diff', options.path.urn],
  updateCustomAppMutation: () => ({}),
}));

vi.mock('@/api-client', () => ({
  getAppComposeDiff: vi.fn(),
}));

vi.mock('./+types/custom-app-edit-page', () => ({
  Route: {},
}));

import EditPageContent, { clientLoader } from './custom-app-edit-page';
import { getAppComposeDiff } from '@/api-client';

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

  it('names the refused action when the Hub turns the save down', () => {
    composeCurrent.value = undefined;
    toastError.mockClear();

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps(undefined)} />
      </MemoryRouter>,
    );
    expect(mutationOptions.current?.onError).toBeTypeOf('function');
    mutationOptions.current?.onError?.({ message: 'APP_ACTION_GRANT_DENIED', intlParams: { action: 'configure', app: 'my-app' } });

    expect(toastError).toHaveBeenCalledWith('You are not allowed to configure this app.');
  });

  // The editor reads the stored compose from a query that stays fresh for 30 seconds. Coming back to it
  // right after a save showed the config from before the save until that query was dropped.
  it('drops the cached compose after a save so the editor shows what was saved', () => {
    composeCurrent.value = undefined;
    invalidateQueries.mockClear();

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps(undefined)} />
      </MemoryRouter>,
    );
    mutationOptions.current?.onSuccess?.();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['compose-diff', 'my-app:_user'] });
    expect(mockNavigate).toHaveBeenCalledWith('/apps/my-app');
  });

  // The compose holds the app's env values, so a member is refused it. A member who follows an old link
  // to the editor lands on the app's page instead of an error.
  it('sends someone refused the compose to the app page', async () => {
    vi.mocked(getAppComposeDiff).mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));

    const result = await clientLoader({ params: { appId: 'my-app' } } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get('Location')).toBe('/apps/my-app');
  });
});
