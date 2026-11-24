import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, useUserContext, useNavigate, searchParams } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useUserContext: vi.fn(),
  useNavigate: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => useNavigate,
    useSearchParams: () => [searchParams.current],
    Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
  };
});

vi.mock('@tanstack/react-query', () => ({ useQuery: (options: unknown) => useQuery(options) }));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({ getAppOptions: () => ({ queryKey: ['getApp'] }) }));
vi.mock('@/context/user-context', () => ({ useUserContext }));
vi.mock('@/components/app-logo/app-logo', () => ({ AppLogo: ({ urn }: { urn?: string }) => <div data-testid="app-logo" data-urn={urn} /> }));
vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({ PageLoadingSpinner: () => <div data-testid="page-loading" /> }));

import MemoryConnectReturnPage from './memory-connect-return-page';

describe('MemoryConnectReturnPage', () => {
  beforeEach(() => {
    useUserContext.mockReturnValue({ isLoggedIn: true, isLoading: false });
    useQuery.mockReturnValue({ data: { info: { name: 'Hermes' } } });
    useNavigate.mockReset();
    searchParams.current = new URLSearchParams({ app: 'ci-hermes:ci-marketplace' });
  });

  it('offers a link back into the Hub app on this app, named by the server', () => {
    render(<MemoryConnectReturnPage />);

    expect(screen.getByText('MEMORY_CONNECT_RETURN_TITLE')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'MEMORY_CONNECT_RETURN_BUTTON' }).getAttribute('href')).toBe(
      'cihub://intent/app?urn=ci-hermes%3Aci-marketplace',
    );
  });

  it('says a generic title until the server has named the app', () => {
    useQuery.mockReturnValue({ data: undefined });
    render(<MemoryConnectReturnPage />);

    expect(screen.getByText('MEMORY_CONNECT_RETURN_TITLE_GENERIC')).toBeTruthy();
  });

  it('lets the person stay in the browser instead', () => {
    render(<MemoryConnectReturnPage />);

    fireEvent.click(screen.getByRole('button', { name: 'MEMORY_CONNECT_RETURN_STAY' }));
    expect(useNavigate).toHaveBeenCalledWith('/home');
  });

  it('sends a link without a real app id home, so it can never build a deep link from junk', () => {
    searchParams.current = new URLSearchParams({ app: '"><script>' });
    render(<MemoryConnectReturnPage />);

    expect(screen.getByTestId('navigate').getAttribute('data-to')).toBe('/home');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('sends a signed-out browser to sign in', () => {
    useUserContext.mockReturnValue({ isLoggedIn: false, isLoading: false });
    render(<MemoryConnectReturnPage />);

    expect(screen.getByTestId('navigate').getAttribute('data-to')).toBe('/login');
  });
});
