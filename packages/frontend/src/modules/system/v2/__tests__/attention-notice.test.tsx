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
});
