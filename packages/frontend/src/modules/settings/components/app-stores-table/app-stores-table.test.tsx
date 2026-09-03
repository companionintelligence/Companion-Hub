import { render, screen } from '@/tests/test-utils';
import type { AppStore } from '@/types/app.types';
import { describe, expect, it, vi } from 'vitest';
import { AppStoresTable } from './app-stores-table';

vi.mock('../add-app-store-dialog/add-app-store-dialog', () => ({
  AddAppStoreDialog: () => <button type="button">Add app store</button>,
}));

vi.mock('../edit-app-store-dialog/edit-app-store-dialog', () => ({
  EditAppStoreDialog: () => <button type="button">Edit</button>,
}));

vi.mock('../delete-app-store-dialog/delete-app-store-dialog', () => ({
  DeleteAppStoreDialog: () => <button type="button">Delete</button>,
}));

const APP_STORE: AppStore = {
  slug: 'community-apps',
  name: 'Community Apps',
  enabled: true,
  url: 'https://community.example.com/api',
};

describe('AppStoresTable', () => {
  it('renders URL column values as plain text, not links', () => {
    render(<AppStoresTable appStores={[APP_STORE]} />);

    const urlText = screen.getByText(APP_STORE.url);
    expect(urlText).toBeInTheDocument();
    expect(urlText.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: APP_STORE.url })).not.toBeInTheDocument();
    expect(urlText).toHaveClass('block', 'max-w-[28rem]', 'truncate');
  });

  it('keeps row actions available', () => {
    render(<AppStoresTable appStores={[APP_STORE]} />);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
