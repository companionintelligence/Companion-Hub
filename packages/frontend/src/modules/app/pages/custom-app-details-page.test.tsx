import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useCustomAppAccess, appQuery } = vi.hoisted(() => ({
  useCustomAppAccess: vi.fn(() => ({ actions: [], may: () => false })),
  appQuery: { isLoading: true, isError: false, data: undefined as unknown },
}));

vi.mock('react-router', () => ({
  useParams: () => ({ appId: 'whoami-check' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => appQuery,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['getApp'] }),
}));

vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({
  PageLoadingSpinner: () => <div data-testid="page-loading" />,
}));

vi.mock('../helpers/use-custom-app-access', () => ({ useCustomAppAccess }));

vi.mock('./custom-app-details-page-content', () => ({
  CustomAppDetailsPageContent: () => <div data-testid="custom-app-content" />,
}));

vi.mock('@/components/empty-page/empty-page', () => ({
  EmptyPage: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="empty-page">
      {title} {subtitle}
    </div>
  ),
}));

vi.mock('../components/port-expose-details-view/port-expose-details-view', () => ({
  PortExposeDetailsView: () => <div data-testid="port-expose-view" />,
}));

import { CustomAppDetailsPage } from './custom-app-details-page';
import { TranslatableError } from '@/types/error.types';

describe('CustomAppDetailsPage', () => {
  beforeEach(() => {
    useCustomAppAccess.mockClear();
  });

  // The controls wait on what this person may do. Asked only once the app had loaded, the question
  // queued behind the page's other requests and the controls came seconds late.
  it('asks what this person may do while the app is still loading', () => {
    render(<CustomAppDetailsPage />);

    expect(screen.getByTestId('page-loading')).toBeInTheDocument();
    expect(useCustomAppAccess).toHaveBeenCalled();
  });

  // The page said "App whoami-check:_user not found" and blamed the store, which a custom app never came from.
  it('says an app that is not installed was not found, without its internal id', () => {
    Object.assign(appQuery, {
      isLoading: false,
      isError: true,
      data: undefined,
      error: new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, { status: 404, url: '/api/apps/whoami-check%3A_user' }),
    });

    render(<CustomAppDetailsPage />);

    expect(screen.getByTestId('empty-page')).toHaveTextContent('CUSTOM_APP_NOT_FOUND_TITLE CUSTOM_APP_NOT_FOUND_SUBTITLE');
    expect(screen.queryByText(/_user/)).not.toBeInTheDocument();
  });

  it('says the app did not load when the Hub failed to answer', () => {
    Object.assign(appQuery, {
      isLoading: false,
      isError: true,
      data: undefined,
      error: new TranslatableError('COMMON_AN_ERROR_OCCURRED', {}, { status: 500, url: '/api/apps/whoami-check%3A_user' }),
    });

    render(<CustomAppDetailsPage />);

    expect(screen.getByTestId('empty-page')).toHaveTextContent('CUSTOM_APP_LOAD_FAILED_TITLE CUSTOM_APP_LOAD_FAILED_SUBTITLE');
  });
});
