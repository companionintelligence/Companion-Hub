import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

const { mockNavigate, composeCurrent, mutationOptions, toastError, invalidateQueries, loadSaved } = vi.hoisted(() => ({
  loadSaved: vi.fn(),
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

// One object per answer, as react-query keeps an unchanged answer's identity. A new object on each
// render reads the config again on each render.
const answers = new Map<string, { current: string }>();
function answerFor(current: string) {
  const answer = answers.get(current) ?? { current };
  answers.set(current, answer);
  return answer;
}

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: composeCurrent.value ? answerFor(composeCurrent.value) : undefined }),
  useMutation: (options: typeof mutationOptions.current) => {
    mutationOptions.current = options;
    return { mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/components/multi-service-form/multi-service-form', () => ({
  MultiServiceForm: () => <div data-testid="edit-form" />,
}));

vi.mock('@/stores/multiServiceStore', async () => ({
  ...(await vi.importActual<typeof import('@/stores/multiServiceStore')>('@/stores/multiServiceStore')),
  useMultiServiceStore: () => ({ loadSaved, resetToDefaults: vi.fn() }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppComposeDiffOptions: () => ({ queryKey: ['compose-diff'] }),
  // The page reads the app's display name for its title.
  getAppOptions: () => ({ queryKey: ['app'] }),
  getAppComposeDiffQueryKey: (options: { path: { urn: string } }) => ['compose-diff', options.path.urn],
  getAppQueryKey: (options: { path: { urn: string } }) => ['app', options.path.urn],
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
    // The parse-error test above already navigated to the same path.
    mockNavigate.mockClear();

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps(undefined)} />
      </MemoryRouter>,
    );
    mutationOptions.current?.onSuccess?.();

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['compose-diff', 'my-app:_user'] });
    // The app's own record too, so its page shows the restart a save to a running app owes (#2421).
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['app', 'my-app:_user'] });
    expect(mockNavigate).toHaveBeenCalledWith('/apps/my-app');
  });

  // The form has no fields for per-architecture overrides. Unless the page keeps them beside it, the
  // next save writes the compose back without them.
  it('keeps the stored overrides for the next save', () => {
    const overrides = [{ architecture: 'arm64', services: [{ name: 'web', internalPort: 8080 }] }];
    const stored = JSON.stringify({ schemaVersion: 2, services: [{ name: 'web', image: 'alpine:3.20', isMain: true, internalPort: 80 }], overrides });
    composeCurrent.value = stored;

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps({ composeDiff: { current: stored } })} />
      </MemoryRouter>,
    );

    expect(loadSaved).toHaveBeenCalledWith([expect.objectContaining({ name: 'web' })], overrides);
  });

  // A config saved before a label rule existed. The Hub leaves those labels out of the running app; the
  // editor opens it with them, so they can be removed, and says which one a save refuses.
  it('opens a saved config that holds labels a save now refuses, and names each one', () => {
    const extraLabels = { 'com.example.team': 'web', 'traefik.docker.network': 'another-app_network', 'ci-hub.appurn': 'other-app:ci-marketplace' };
    const stored = JSON.stringify({
      schemaVersion: 2,
      services: [{ name: 'web', image: 'nginx:1.27-alpine', isMain: true, internalPort: 80, extraLabels }],
    });
    composeCurrent.value = stored;
    loadSaved.mockClear();

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps({ composeDiff: { current: stored } })} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('edit-form')).toBeInTheDocument();
    expect(screen.queryByText('Invalid configuration. Please check your services.')).not.toBeInTheDocument();
    expect(loadSaved).toHaveBeenCalledWith([expect.objectContaining({ name: 'web', extraLabels })], undefined);
    const notice = screen.getByTestId('custom-app-edit-refused-label');
    expect(notice).toHaveTextContent('This app has labels the Hub no longer accepts');
    expect(notice).toHaveTextContent('Service web:');
    expect(notice).toHaveTextContent('traefik.docker.network can only name a Hub network the app is on: ci-hub_network, ci-os-hub_network.');
    expect(notice).toHaveTextContent('Remove ci-hub.appurn.');
  });

  it('still refuses to open a saved config with a privileged service', () => {
    const stored = JSON.stringify({
      schemaVersion: 2,
      services: [
        { name: 'web', image: 'nginx:1.27-alpine', isMain: true, internalPort: 80, privileged: true, extraLabels: { 'traefik.docker.network': 'x' } },
      ],
    });
    composeCurrent.value = stored;

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps({ composeDiff: { current: stored } })} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Invalid configuration. Please check your services.')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-form')).not.toBeInTheDocument();
  });

  it('shows no notice for a saved config that breaks no rule', () => {
    const stored = JSON.stringify({ schemaVersion: 2, services: [{ name: 'web', image: 'nginx:1.27-alpine', isMain: true, internalPort: 80 }] });
    composeCurrent.value = stored;

    render(
      <MemoryRouter>
        <EditPageContent {...pageProps({ composeDiff: { current: stored } })} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('edit-form')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-app-edit-refused-label')).not.toBeInTheDocument();
  });

  // The compose holds the app's env values, so a member is refused it. A member who follows an old link
  // to the editor lands on the app's page instead of an error.
  // The client answers a refusal with the error; it doesn't throw.
  it('sends someone refused the compose to the app page', async () => {
    for (const status of [401, 403]) {
      vi.mocked(getAppComposeDiff).mockResolvedValue({
        error: new Error('APP_ACTION_GRANT_DENIED'),
        response: new Response(null, { status }),
      } as never);

      const result = await clientLoader({ params: { appId: 'my-app' } } as never);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).headers.get('Location')).toBe('/apps/my-app');
    }
  });

  it('sends a request that fails outright to the app page', async () => {
    vi.mocked(getAppComposeDiff).mockRejectedValue(new Error('Failed to fetch'));

    const result = await clientLoader({ params: { appId: 'my-app' } } as never);

    expect((result as Response).headers.get('Location')).toBe('/apps/my-app');
  });

  it('sends an app the Hub does not have to the app list', async () => {
    vi.mocked(getAppComposeDiff).mockResolvedValue({ error: new Error('NOT_FOUND'), response: new Response(null, { status: 404 }) } as never);

    const result = await clientLoader({ params: { appId: 'my-app' } } as never);

    expect((result as Response).headers.get('Location')).toBe('/apps');
  });
});
