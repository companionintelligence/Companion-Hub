import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AlternativesCatalog } from './alternatives-catalog';

describe('AlternativesCatalog', () => {
  it('colors the section icon with a real class and translates the heading', () => {
    const { container } = render(
      <MemoryRouter>
        <AlternativesCatalog
          marketplaceSlug="ci-marketplace"
          alternatives={{
            data: [
              {
                proprietary: [{ name: 'Dropbox', icon: '', url: null }],
                alternatives: [{ name: 'Nextcloud', icon: '', url: 'https://nextcloud.com', appSlug: 'nextcloud' }],
              },
            ],
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Data' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'data' })).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveClass('text-green-600');
  });
});
