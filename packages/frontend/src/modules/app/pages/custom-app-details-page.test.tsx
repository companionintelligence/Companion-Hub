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

vi.mock('../components/port-expose-details-view/port-expose-details-view', () => ({
  PortExposeDetailsView: () => <div data-testid="port-expose-view" />,
}));

import { CustomAppDetailsPage } from './custom-app-details-page';

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
});
