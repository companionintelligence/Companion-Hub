import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { HorizontalAppList } from './horizontal-app-list';

const { getMarketplaceAppImageUrl } = vi.hoisted(() => ({
  getMarketplaceAppImageUrl: vi.fn(() => 'logo.png'),
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

type Entry = Parameters<typeof HorizontalAppList>[0]['apps'][number];

/** An entry as `addOptimisticInstalledApp` writes it: a synthetic row that is not in the DB yet. */
const ghost = (urn: string, name: string, id: number): Entry => ({ info: { urn, name }, app: { id, status: 'installing' } }) as unknown as Entry;

/** An entry as the server returns it: a real DB row with a real serial id. */
const real = (urn: string, name: string, id: number): Entry => ({ info: { urn, name }, app: { id, status: 'running' } }) as unknown as Entry;

const renderList = (apps: Entry[]) =>
  render(
    <MemoryRouter>
      <HorizontalAppList apps={apps} />
    </MemoryRouter>,
  );

describe('HorizontalAppList', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  // The onboarding ghost-tile bug. Every optimistic entry used to carry `app.id: -1`, and the list
  // keyed tiles by `app.id` — so N optimistic apps collided on one React key. React keeps a single
  // fiber per key, so when the array was swapped for the real rows only ONE stale fiber was deleted
  // and the other N-1 kept their DOM nodes: N apps rendered as 2N-1 tiles.
  it('MUST NOT strand ghost tiles when optimistic rows are replaced by real ones', () => {
    const optimistic = [ghost('ci-hermes:ci-marketplace', 'Hermes', -1), ghost('ci-import-tools:ci-marketplace', 'Memory Import Tools', -1)];

    const { rerender } = renderList(optimistic);
    expect(screen.getAllByRole('link')).toHaveLength(2);

    rerender(
      <MemoryRouter>
        <HorizontalAppList apps={[real('ci-hermes:ci-marketplace', 'Hermes', 1), real('ci-import-tools:ci-marketplace', 'Import Tools', 2)]} />
      </MemoryRouter>,
    );

    // Two apps must render two tiles — not three.
    expect(screen.getAllByRole('link')).toHaveLength(2);
    // And React must never have warned about duplicate keys, which is what causes the stranding.
    const warnedOnDuplicateKey = consoleError.mock.calls.some((args: unknown[]) => /same key|two children/i.test(String(args[0])));
    expect(warnedOnDuplicateKey).toBe(false);
  });

  it('MUST update a tile in place as it goes from optimistic to installed', () => {
    const urn = 'ci-import-tools:ci-marketplace';

    const { rerender } = renderList([ghost(urn, 'Memory Import Tools', -1)]);
    expect(screen.getByText('Memory Import Tools')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <HorizontalAppList apps={[real(urn, 'Import Tools', 4)]} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('Import Tools')).toBeInTheDocument();
    expect(screen.queryByText('Memory Import Tools')).not.toBeInTheDocument();
  });

  // A urn identifies an app exactly once. The DB has no unique index on (app_name, app_store_slug),
  // so keep the UI correct even if a duplicate row ever reaches it.
  it('MUST render a urn only once even if the server returns it twice', () => {
    renderList([real('ci-hermes:ci-marketplace', 'Hermes', 1), real('ci-hermes:ci-marketplace', 'Hermes', 9)]);

    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('MUST show the store call-to-action when nothing is installed', () => {
    renderList([]);

    expect(screen.queryAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('Click here to install your first app')).toBeInTheDocument();
  });
});
