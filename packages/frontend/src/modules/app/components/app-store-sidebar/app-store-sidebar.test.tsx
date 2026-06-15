import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockNavigate, mockStoreState } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockStoreState: {
    setCategory: vi.fn(),
    category: undefined as string | undefined,
    setSearch: vi.fn(),
    search: '',
    storeId: 'ci-apps',
  },
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/app-store' }),
  };
});

vi.mock('@/stores/app-store', () => ({
  useAppStoreState: () => mockStoreState,
}));

import { AppStoreSidebar } from './app-store-sidebar';

describe('AppStoreSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.category = undefined;
    mockStoreState.search = '';
    mockStoreState.storeId = 'ci-apps';
  });

  it('syncs the desktop search input from the shared store state', () => {
    mockStoreState.search = 'from page';

    const { rerender } = render(<AppStoreSidebar />);

    expect(screen.getByPlaceholderText('Search apps...')).toHaveValue('from page');

    mockStoreState.search = 'changed externally';
    rerender(<AppStoreSidebar />);

    expect(screen.getByPlaceholderText('Search apps...')).toHaveValue('changed externally');
  });

  it('updates the shared search state when typing', () => {
    render(<AppStoreSidebar />);

    fireEvent.change(screen.getByPlaceholderText('Search apps...'), { target: { value: 'router' } });

    expect(mockStoreState.setSearch).toHaveBeenCalledWith('router');
    expect(screen.getByPlaceholderText('Search apps...')).toHaveValue('router');
  });

  it('keeps the desktop sidebar elevated and sticky while the store page scrolls', () => {
    const { container } = render(<AppStoreSidebar />);

    expect(container.querySelector('aside')).toHaveClass('sticky', 'top-4', 'shadow-sm', 'shadow-slate-300/70', 'bg-card/90');
  });
});
