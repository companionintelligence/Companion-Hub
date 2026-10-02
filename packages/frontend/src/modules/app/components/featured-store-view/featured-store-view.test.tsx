import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { FeaturedStoreView } from './featured-store-view';

const apps = Array.from({ length: 20 }, (_, index) => ({
  urn: `app-${index}:ci-marketplace`,
  name: `App ${index}`,
  short_desc: 'A store app',
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: apps,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/modules/app/components/app-card/app-card', () => ({
  AppCard: ({ app }: { app: { name: string } }) => <div>{app.name}</div>,
}));

describe('FeaturedStoreView', () => {
  it('opens a section a window at a time instead of mounting every card', () => {
    render(
      <MemoryRouter>
        <FeaturedStoreView storeId="ci-marketplace" installedAppUrns={new Set()} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/^App /)).toHaveLength(16);

    fireEvent.click(screen.getAllByRole('button', { name: /View all 20/ })[0]);

    expect(screen.getAllByText(/^App /)).toHaveLength(28);
    expect(screen.getAllByRole('button', { name: 'Show more' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

    expect(screen.getAllByText(/^App /)).toHaveLength(32);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});
