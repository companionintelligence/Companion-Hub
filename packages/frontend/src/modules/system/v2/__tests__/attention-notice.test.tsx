import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionNotice, type Notice } from '../attention-notice';

const peers = (count: number): Notice => ({ id: 'peers', tone: 'warn', text: `${count} Hubs in your pool can't be reached.` });

function renderNotice(notices: Notice[]) {
  return render(
    <MemoryRouter>
      <AttentionNotice notices={notices} />
    </MemoryRouter>,
  );
}

describe('Attention notice', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows nothing when nothing is wrong', () => {
    renderNotice([]);

    expect(screen.queryByTestId('resources-notice')).toBeNull();
  });

  it('runs a problem action', () => {
    const onClick = vi.fn();
    renderNotice([{ ...peers(2), action: { label: 'Show pool', onClick } }]);

    fireEvent.click(screen.getByRole('button', { name: 'Show pool' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('stays dismissed while the problems are the same, and comes back when they change', () => {
    const { unmount } = renderNotice([peers(2)]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('resources-notice')).toBeNull();
    unmount();

    const again = renderNotice([peers(2)]);
    expect(screen.queryByTestId('resources-notice')).toBeNull();
    again.unmount();

    renderNotice([peers(3)]);
    expect(screen.getByTestId('resources-notice')).toBeTruthy();
  });

  it('comes back for a different app with the same count', () => {
    const apps = (key: string): Notice => ({ id: 'apps', key, tone: 'bad', text: "1 app isn't responding." });
    const { unmount } = renderNotice([apps('immich:ci-marketplace')]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    unmount();

    renderNotice([apps('actual:ci-marketplace')]);
    expect(screen.getByTestId('resources-notice')).toBeTruthy();
  });

  it('forgets a dismissal once every check is clean, so the same fault returning is shown', () => {
    const first = renderNotice([peers(2)]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    first.unmount();

    // Still loading: no notices, but nothing has been checked, so the dismissal stands.
    render(
      <MemoryRouter>
        <AttentionNotice notices={[]} />
      </MemoryRouter>,
    ).unmount();
    const loading = renderNotice([peers(2)]);
    expect(screen.queryByTestId('resources-notice')).toBeNull();
    loading.unmount();

    render(
      <MemoryRouter>
        <AttentionNotice notices={[]} allClear />
      </MemoryRouter>,
    ).unmount();
    renderNotice([peers(2)]);
    expect(screen.getByTestId('resources-notice')).toBeTruthy();
  });
});
