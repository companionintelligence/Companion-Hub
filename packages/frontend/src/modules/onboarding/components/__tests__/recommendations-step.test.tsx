import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
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
      media: [{ proprietary: [{ name: 'Google Photos' }], alternatives: [{ appSlug: 'immich', name: 'Immich', icon: '' }] }],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

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
    renderWithRouter(<Harness onEmit={onEmit} />);

    // No runaway re-render loop: the empty selection is emitted exactly once.
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });

  it('re-emits only when the selected slugs actually change', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    renderWithRouter(<Harness onEmit={onEmit} />);
    onEmit.mockClear();

    await user.click(screen.getByTestId('recommended-app-checkbox-immich'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'immich', urn: 'urn:store:immich' })]);

    onEmit.mockClear();
    await user.click(screen.getByTestId('recommended-app-checkbox-immich'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });

  it('does not show the empty-state message when the catalog query fails', () => {
    mockCatalogState.isError = true;

    renderWithRouter(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'COMMON_RETRY' })).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_NO_MATCHING_STORE_APPS')).not.toBeInTheDocument();
  });

  it('matches portal catalog entries that only expose urn (no id)', async () => {
    mockCatalogState.apps = [{ name: 'Immich', urn: 'immich:ci-marketplace', short_desc: 'Photos' }];

    const user = userEvent.setup();
    const onEmit = vi.fn();
    renderWithRouter(<Harness onEmit={onEmit} />);
    onEmit.mockClear();

    await user.click(screen.getByTestId('recommended-app-checkbox-immich'));
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'immich', urn: 'immich:ci-marketplace' })]);
  });

  it('shows loading copy while the catalog is retrying an empty response', () => {
    mockCatalogState.isRetryingEmptyCatalog = true;
    mockCatalogState.isCatalogSettled = false;

    renderWithRouter(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getByText('ONBOARDING_RECOMMENDATIONS_LOADING')).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_NO_MATCHING_STORE_APPS')).not.toBeInTheDocument();
  });

  it('renders the 20-item chart and keeps every synced alternative selectable', () => {
    mockCatalogState.apps = [
      { id: 'immich', name: 'Immich', urn: 'urn:store:immich', short_desc: 'Photos' },
      { id: 'mattermost', name: 'Mattermost', urn: 'urn:store:mattermost', short_desc: 'Chat' },
      { id: 'nextcloud', name: 'Nextcloud', urn: 'urn:store:nextcloud', short_desc: 'Files' },
      { id: 'gitea', name: 'Gitea', urn: 'urn:store:gitea', short_desc: 'Git' },
      { id: 'n8n', name: 'n8n', urn: 'urn:store:n8n', short_desc: 'Automation' },
    ];

    renderWithRouter(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getByTestId('recommended-alternatives-chart')).toBeInTheDocument();
    expect(screen.getAllByTestId('recommended-app')).toHaveLength(20);
    expect(screen.getAllByRole('checkbox')).toHaveLength(20);
    expect(screen.getByTestId('recommended-app-checkbox-wallos')).toBeInTheDocument();
    expect(screen.queryByTestId('recommended-app-checkbox-pocketbase')).not.toBeInTheDocument();
    expect(screen.getByTestId('recommended-private-icon-microsoft-office')).toBeInTheDocument();
    expect(screen.getByTestId('recommended-private-icon-google-workspace')).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_RECOMMENDED_APPS_CLOUD_SUBSCRIPTION')).not.toBeInTheDocument();
    expect(screen.queryByText('APP_STORE_OPEN_SOURCE_ALTERNATIVES')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recommended-agent-selection')).not.toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING_RECOMMENDED_APPS_COUNT_SUFFIX')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recommended-app-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('show-more-recommendations')).not.toBeInTheDocument();
  });

  it('keeps the full shortlist visible when only one alternative is synced', () => {
    renderWithRouter(<RecommendationsStep embedded detectedServices={[]} onChange={vi.fn()} />);

    expect(screen.getAllByTestId('recommended-app')).toHaveLength(20);
    expect(screen.queryByTestId('recommended-app-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('show-more-recommendations')).not.toBeInTheDocument();
  });
});
