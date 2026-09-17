import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/app-store-sidebar/app-store-sidebar', () => ({
  AppStoreSidebar: () => <aside data-testid="store-sidebar" />,
}));

import AppStoreLayout from './app-store-layout';

describe('AppStoreLayout', () => {
  it('scrolls the store pages in a pane beside the sidebar', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/store']}>
        <Routes>
          <Route element={<AppStoreLayout />}>
            <Route path="/store" element={<h1>Store page</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const pane = container.querySelector('[data-page-scroller="store"]');
    expect(pane).toHaveClass('relative', 'min-h-0', 'overflow-y-auto');
    expect(pane).toContainElement(screen.getByRole('heading', { name: 'Store page' }));
    expect(pane).not.toContainElement(screen.getByTestId('store-sidebar'));
  });

  it('reaches the window edge with the pane, and nothing around it clips that', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/store']}>
        <Routes>
          <Route element={<AppStoreLayout />}>
            <Route path="/store" element={<h1>Store page</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // The pane stretches over the page gutter so its scrollbar sits at the
    // window's right edge. A clipping row hid that part of the pane, scrollbar
    // included.
    const pane = container.querySelector('[data-page-scroller="store"]');
    expect(pane?.className).toMatch(/(^|\s)page-scroller-edge-\d+(\s|$)/);
    expect(pane?.parentElement).not.toHaveClass('overflow-hidden');
  });
});
