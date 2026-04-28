import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsOptions: () => ({ queryKey: ['installed'] }),
  getLinksOptions: () => ({ queryKey: ['links'] }),
  deleteLinkMutation: () => ({ mutationFn: vi.fn() }),
  createLinkMutation: () => ({ mutationFn: vi.fn() }),
  updateLinkMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@/lib/hooks/use-disclosure', () => ({
  useDisclosure: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../components/dialogs/add-link/add-link-dialog', () => ({
  AddLinkDialog: () => null,
}));

import { useQuery } from '@tanstack/react-query';
import MyAppsPage from './my-apps-page';

const mockUseQuery = vi.mocked(useQuery);

function makeInstalledApp(overrides: { available?: boolean; name?: string; status?: string } = {}) {
  const name = overrides.name ?? 'test-app';
  return {
    info: {
      urn: `${name}:store1`,
      name,
      short_desc: 'A test app',
      deprecated: false,
      available: overrides.available ?? true,
    },
    app: {
      id: name,
      status: overrides.status ?? 'running',
      version: 1,
      ignoredVersion: null,
      pendingRestart: false,
    },
    metadata: { latestVersion: 1 },
  };
}

describe('MyAppsPage — unavailable installed apps', () => {
  it('renders installed app even when available=false', () => {
    mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      if (opts.queryKey[0] === 'installed') {
        return {
          data: { installed: [makeInstalledApp({ available: false, name: 'unavailable-app' })] },
          isLoading: false,
        } as ReturnType<typeof useQuery>;
      }
      return { data: { links: [] }, isLoading: false } as ReturnType<typeof useQuery>;
    });

    render(
      <MemoryRouter>
        <MyAppsPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('installed-app-unavailable-app')).toBeInTheDocument();
  });

  it('renders available app and it is navigable', () => {
    mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      if (opts.queryKey[0] === 'installed') {
        return {
          data: { installed: [makeInstalledApp({ available: true, name: 'my-running-app' })] },
          isLoading: false,
        } as ReturnType<typeof useQuery>;
      }
      return { data: { links: [] }, isLoading: false } as ReturnType<typeof useQuery>;
    });

    render(
      <MemoryRouter>
        <MyAppsPage />
      </MemoryRouter>,
    );

    const link = screen.getByTestId('installed-app-my-running-app');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/apps/store1/my-running-app');
  });

  it('shows section headers when both apps and links exist', () => {
    mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      if (opts.queryKey[0] === 'installed') {
        return {
          data: { installed: [makeInstalledApp({ name: 'app1' })] },
          isLoading: false,
        } as ReturnType<typeof useQuery>;
      }
      return {
        data: { links: [{ id: 'link1', title: 'My Link', url: 'https://example.com', description: '', iconUrl: '' }] },
        isLoading: false,
      } as ReturnType<typeof useQuery>;
    });

    render(
      <MemoryRouter>
        <MyAppsPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('section-apps')).toBeInTheDocument();
    expect(screen.getByTestId('section-links')).toBeInTheDocument();
  });

  it('uses safe rel attributes on custom link anchors', () => {
    mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      if (opts.queryKey[0] === 'installed') {
        return { data: { installed: [] }, isLoading: false } as ReturnType<typeof useQuery>;
      }
      return {
        data: { links: [{ id: 'link1', title: 'External', url: 'https://evil.com', description: '', iconUrl: '' }] },
        isLoading: false,
      } as ReturnType<typeof useQuery>;
    });

    render(
      <MemoryRouter>
        <MyAppsPage />
      </MemoryRouter>,
    );

    const wrapper = screen.getByTestId('custom-link-link1');
    const anchor = wrapper.querySelector('a');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(anchor).toHaveAttribute('target', '_blank');
  });
});
