import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OnboardingApp } from '../../helpers/types';
import { CompanionAppsCard } from '../ai-setup/companion-apps-card';

const { mockCatalogState } = vi.hoisted(() => ({
  mockCatalogState: {
    isLoading: false,
    apps: [
      { id: 'ci-memory', name: 'Companion Memory', urn: 'urn:store:ci-memory', short_desc: 'Memory server' },
      { id: 'ci-import-tools', name: 'Import Tools', urn: 'urn:store:ci-import-tools', short_desc: 'Import data' },
    ] as Array<{ id: string; name: string; urn: string; short_desc: string }>,
  },
}));

vi.mock('../../helpers/use-marketplace-catalog-apps', () => ({
  useMarketplaceCatalogApps: () => ({
    apps: mockCatalogState.isLoading ? [] : mockCatalogState.apps,
    isLoading: mockCatalogState.isLoading,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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
    mockCatalogState.apps = [
      { id: 'ci-memory', name: 'Companion Memory', urn: 'urn:store:ci-memory', short_desc: 'Memory server' },
      { id: 'ci-import-tools', name: 'Import Tools', urn: 'urn:store:ci-import-tools', short_desc: 'Import data' },
    ];
  });

  it('pre-selects both companion apps and emits them with public exposure', async () => {
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => {
      expect(onEmit).toHaveBeenCalled();
    });

    expect(onEmit).toHaveBeenLastCalledWith([
      expect.objectContaining({ appSlug: 'ci-memory', urn: 'urn:store:ci-memory', exposureMode: 'cloudflare' }),
      expect.objectContaining({ appSlug: 'ci-import-tools', urn: 'urn:store:ci-import-tools', exposureMode: 'cloudflare' }),
    ]);
  });

  it('allows deselecting a companion app', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => expect(onEmit).toHaveBeenCalled());
    onEmit.mockClear();

    await user.click(screen.getByTestId('companion-app-ci-memory'));
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'ci-import-tools', exposureMode: 'cloudflare' })]);
  });

  it('marks unavailable apps as disabled when missing from the store', async () => {
    mockCatalogState.apps = [{ id: 'ci-import-tools', name: 'Import Tools', urn: 'urn:store:ci-import-tools', short_desc: 'Import data' }];

    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    await waitFor(() => expect(onEmit).toHaveBeenCalled());
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'ci-import-tools' })]);
    expect(screen.getByTestId('companion-app-ci-memory')).toBeDisabled();
    expect(screen.getByText('ONBOARDING_COMPANION_APP_UNAVAILABLE')).toBeInTheDocument();
  });

  it('shows skeletons while the catalog is loading', () => {
    mockCatalogState.isLoading = true;
    render(<CompanionAppsCard publicExposureMode="cloudflare" onChange={vi.fn()} />);
    expect(screen.getAllByTestId('companion-app-skeleton')).toHaveLength(2);
  });
});
