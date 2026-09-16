import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OnboardingApp } from '../../helpers/types';
import { CompanionAppsCard } from '../ai-setup/companion-apps-card';

const { mockCatalogState } = vi.hoisted(() => ({
  mockCatalogState: {
    isLoading: false,
    isRetryingEmptyCatalog: false,
    isCatalogSettled: true,
    apps: [{ id: 'ci-memory', name: 'CI Memory', urn: 'urn:store:ci-memory', short_desc: 'Memory server' }] as Array<{
      id?: string;
      name: string;
      urn: string;
      short_desc: string;
    }>,
  },
}));

vi.mock('../../helpers/use-marketplace-catalog-apps', () => ({
  useMarketplaceCatalogApps: () => ({
    apps: mockCatalogState.isLoading || mockCatalogState.isRetryingEmptyCatalog ? [] : mockCatalogState.apps,
    isLoading: mockCatalogState.isLoading,
    isRetryingEmptyCatalog: mockCatalogState.isRetryingEmptyCatalog,
    isCatalogSettled: mockCatalogState.isCatalogSettled,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// lottie-web reaches for a canvas 2D context at import time, which jsdom doesn't provide;
// the app's own logic under test here doesn't depend on the animation actually playing.
vi.mock('lottie-react', () => ({
  default: () => null,
}));

function Harness({
  onEmit,
  publicExposureMode = 'cloudflare' as const,
}: {
  onEmit: (apps: OnboardingApp[]) => void;
  publicExposureMode?: 'cloudflare' | 'tailscale' | 'local';
}) {
  const [, setSelected] = useState<OnboardingApp[]>([]);
  return (
    <CompanionAppsCard
      publicExposureMode={publicExposureMode}
      onChange={(apps) => {
        onEmit(apps);
        setSelected(apps);
      }}
    />
  );
}

describe('CompanionAppsCard', () => {
  beforeEach(() => {
    mockCatalogState.isLoading = false;
    mockCatalogState.isRetryingEmptyCatalog = false;
    mockCatalogState.isCatalogSettled = true;
    mockCatalogState.apps = [{ id: 'ci-memory', name: 'CI Memory', urn: 'urn:store:ci-memory', short_desc: 'Memory server' }];
  });

  it('pre-selects CI Memory and emits it with public exposure', async () => {
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => {
      expect(onEmit).toHaveBeenCalled();
    });

    expect(onEmit).toHaveBeenLastCalledWith([
      expect.objectContaining({ appSlug: 'ci-memory', urn: 'urn:store:ci-memory', exposureMode: 'cloudflare' }),
    ]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    const memoryOption = screen.getByTestId('companion-app-ci-memory');
    expect(within(memoryOption).getByRole('checkbox', { name: 'ONBOARDING_COMPANION_MEMORY_TITLE' })).toBeChecked();
    expect(within(screen.getByTestId('companion-memory-option')).getByText('ONBOARDING_COMPANION_MEMORY_SECTION_DESC')).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_BUILT_BY_COMPANION')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-app-ci-import-tools')).not.toBeInTheDocument();
  });

  it('allows deselecting CI Memory', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => expect(onEmit).toHaveBeenCalled());
    onEmit.mockClear();

    const memoryOption = screen.getByTestId('companion-app-ci-memory');
    await user.click(within(memoryOption).getByRole('checkbox', { name: 'ONBOARDING_COMPANION_MEMORY_TITLE' }));
    expect(onEmit).toHaveBeenLastCalledWith([]);
    expect(within(memoryOption).getByRole('checkbox', { name: 'ONBOARDING_COMPANION_MEMORY_TITLE' })).not.toBeChecked();
  });

  it('keeps Companion Memory selectable with its canonical marketplace identity when the local catalog is empty', async () => {
    mockCatalogState.apps = [];

    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => expect(onEmit).toHaveBeenCalled());
    expect(onEmit).toHaveBeenLastCalledWith([
      expect.objectContaining({ appSlug: 'ci-memory', urn: 'ci-memory:ci-marketplace', exposureMode: 'cloudflare' }),
    ]);
    expect(within(screen.getByTestId('companion-app-ci-memory')).getByRole('checkbox')).toBeEnabled();
    expect(within(screen.getByTestId('companion-memory-option')).getByText('ONBOARDING_COMPANION_MEMORY_TITLE')).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_COMPANION_APP_UNAVAILABLE')).not.toBeInTheDocument();
  });

  it('pre-selects CI Memory when the catalog arrives after an empty first response', async () => {
    mockCatalogState.isLoading = true;
    mockCatalogState.isRetryingEmptyCatalog = false;
    mockCatalogState.isCatalogSettled = false;
    mockCatalogState.apps = [];

    const onEmit = vi.fn();
    const { rerender } = render(<Harness onEmit={onEmit} />);
    expect(screen.getAllByTestId('companion-app-skeleton')).toHaveLength(1);

    mockCatalogState.isLoading = false;
    mockCatalogState.isRetryingEmptyCatalog = false;
    mockCatalogState.isCatalogSettled = true;
    mockCatalogState.apps = [{ id: 'ci-memory', name: 'CI Memory', urn: 'urn:store:ci-memory', short_desc: 'Memory server' }];
    rerender(<Harness onEmit={onEmit} />);

    await waitFor(() => {
      expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'ci-memory', exposureMode: 'cloudflare' })]);
    });
  });

  it('matches CI Memory by urn when portal entries omit id', async () => {
    mockCatalogState.apps = [{ name: 'CI Memory', urn: 'ci-memory:ci-marketplace', short_desc: 'Memory server' }];

    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => expect(onEmit).toHaveBeenCalled());
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'ci-memory', urn: 'ci-memory:ci-marketplace' })]);
  });

  it('shows skeletons while the catalog is loading', () => {
    mockCatalogState.isLoading = true;
    mockCatalogState.isCatalogSettled = false;
    render(<CompanionAppsCard publicExposureMode="cloudflare" onChange={vi.fn()} />);
    expect(screen.getAllByTestId('companion-app-skeleton')).toHaveLength(1);
  });

  it('shows the privacy callout', () => {
    render(<CompanionAppsCard publicExposureMode="cloudflare" onChange={vi.fn()} />);
    expect(screen.getByTestId('companion-privacy-callout')).toBeInTheDocument();
    expect(screen.getByText('ONBOARDING_COMPANION_PRIVACY_CALLOUT')).toBeInTheDocument();
  });
});
