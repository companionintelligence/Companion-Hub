import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppInfo, AppMetadata } from '@/types/app.types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  uploadAppImageMutation: () => ({}),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ userSettings: { localDomain: 'local.test', sslPort: 443 } }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl: () => 'http://localhost:5002/api/marketplace/apps/whoami-check%3A_user/image',
}));

vi.mock('@/components/custom-app-logo/custom-app-logo', () => ({
  CustomAppLogo: () => <div data-testid="custom-app-logo" />,
}));

vi.mock('../components/app-status/app-status', () => ({
  AppStatus: () => <div data-testid="app-status" />,
}));

vi.mock('../helpers/use-app-url-availability', () => ({
  useAppUrlAvailability: () => ({ state: 'idle', statusMessage: null }),
}));

vi.mock('../containers/app-actions/app-actions', () => ({
  AppActions: () => <div data-testid="app-actions" />,
}));

vi.mock('../containers/app-details-tabs/app-details-tabs', () => ({
  AppDetailsTabs: () => <div data-testid="app-details-tabs" />,
}));

vi.mock('../components/app-backups-card/app-backups-card', () => ({
  AppBackupsCard: () => <div data-testid="app-backups-card" />,
}));

import { CustomAppDetailsPageContent } from './custom-app-details-page-content';

const info = {
  id: 'whoami-check',
  urn: 'whoami-check:_user',
  name: 'Whoami Check',
  version: '1.0.0',
  short_desc: 'User-created custom app',
} as unknown as AppInfo;

describe('CustomAppDetailsPageContent', () => {
  // The store page puts AppDetailsTabs outside its card, so the tabs bring no
  // padding. Here they sit inside the card and used to touch its edges.
  it('insets the notes and information inside the card like the header', () => {
    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={null} metadata={{} as AppMetadata} />);

    const tabs = screen.getByTestId('app-details-tabs');
    expect(screen.getByTestId('app-details')).toContainElement(tabs);
    expect(tabs.parentElement).toHaveClass('p-6', 'pt-0');
  });
});
