import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OnboardingApp } from '../../helpers/types';
import { RecommendationsStep } from '../recommendations-step';

const { mockCatalogState } = vi.hoisted(() => ({
  mockCatalogState: {
    isLoading: false,
    isRetryingEmptyCatalog: false,
    isCatalogSettled: true,
    isError: false,
    apps: undefined as Array<{ id?: string; name: string; urn: string; short_desc: string }> | undefined,
  },
}));

vi.mock('../../helpers/use-marketplace-catalog-apps', () => ({
  useMarketplaceCatalogApps: () => ({
    apps: mockCatalogState.isError
      ? []
      : mockCatalogState.isLoading || mockCatalogState.isRetryingEmptyCatalog
        ? []
        : (mockCatalogState.apps ?? [{ id: 'immich', name: 'Immich', urn: 'urn:store:immich', short_desc: 'Photos' }]),
    isLoading: mockCatalogState.isLoading,
    isRetryingEmptyCatalog: mockCatalogState.isRetryingEmptyCatalog,
    isCatalogSettled: mockCatalogState.isCatalogSettled,
    isError: mockCatalogState.isError,
    refetch: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/portal-alternatives', () => ({
  portalAlternativesQueryOptions: () => ({ queryKey: ['portal-alternatives'] }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      photos: [{ proprietary: [{ name: 'Google Photos' }], alternatives: [{ appSlug: 'immich', name: 'Immich', icon: '' }] }],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// A parent that, like onboarding-page, stores the emitted selection in state AND re-creates the
// detectedServices / onChange references on every render. This is the worst case for the embedded
// emit effect: before the fix it looped forever (onChange -> setState -> re-render -> emit -> ...).
function Harness({ onEmit }: { onEmit: (apps: OnboardingApp[]) => void }) {
  const [, setSelected] = useState<OnboardingApp[]>([]);
  return (
    <RecommendationsStep
      embedded
      detectedServices={[]}
      onChange={(apps) => {
        onEmit(apps);
        setSelected(apps);
      }}
    />
  );
}

describe('RecommendationsStep (embedded emit)', () => {
  beforeEach(() => {
    mockCatalogState.isLoading = false;
    mockCatalogState.isRetryingEmptyCatalog = false;
    mockCatalogState.isCatalogSettled = true;
    mockCatalogState.isError = false;
    mockCatalogState.apps = undefined;
  });

  it('emits the selection once and does not loop on unchanged selections', () => {
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    // No runaway re-render loop: the empty selection is emitted exactly once.
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });

  it('re-emits only when the selected slugs actually change', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);
    onEmit.mockClear();

    await user.click(screen.getByTestId('recommended-app'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'immich', urn: 'urn:store:immich' })]);

    onEmit.mockClear();
    await user.click(screen.getByTestId('recommended-app'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });

  it('does not show the empty-state message when the catalog query fails', () => {
    mockCatalogState.isError = true;

    render(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'COMMON_RETRY' })).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_NO_MATCHING_STORE_APPS')).not.toBeInTheDocument();
  });

  it('matches portal catalog entries that only expose urn (no id)', async () => {
    mockCatalogState.apps = [{ name: 'Immich', urn: 'immich:ci-marketplace', short_desc: 'Photos' }];

    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);
    onEmit.mockClear();

    await user.click(screen.getByTestId('recommended-app'));
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'immich', urn: 'immich:ci-marketplace' })]);
  });

  it('shows loading copy while the catalog is retrying an empty response', () => {
    mockCatalogState.isRetryingEmptyCatalog = true;
    mockCatalogState.isCatalogSettled = false;

    render(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getByText('ONBOARDING_CATALOG_LOADING')).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_NO_MATCHING_STORE_APPS')).not.toBeInTheDocument();
  });
});
