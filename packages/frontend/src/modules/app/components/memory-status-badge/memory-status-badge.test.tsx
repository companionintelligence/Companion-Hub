import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStatusBadge } from './memory-status-badge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { useMemoryConnection } = vi.hoisted(() => ({ useMemoryConnection: vi.fn() }));

vi.mock('../../helpers/use-memory-connection', () => ({
  useMemoryConnection,
}));

/** Only the fields the badge reads; the rest of the hook surface is irrelevant here. */
function mockConnection(partial: Record<string, unknown>) {
  useMemoryConnection.mockReturnValue({
    applicable: true,
    connected: false,
    memoryInstalled: false,
    memoryReady: false,
    providerStatus: 'absent',
    ...partial,
  });
}

describe('MemoryStatusBadge', () => {
  it('renders nothing for a non-consumer app', () => {
    mockConnection({ applicable: false });
    const { container } = render(<MemoryStatusBadge appUrn="some-app:local" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "not installed" when Companion Memory is absent', () => {
    mockConnection({ memoryInstalled: false, providerStatus: 'absent' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_NOT_INSTALLED')).toBeInTheDocument();
  });

  it('shows "starting" while ci-memory is installed but still coming up (not "not connected")', () => {
    mockConnection({ memoryInstalled: true, providerStatus: 'starting' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_STARTING')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_BADGE_NOT_CONNECTED')).not.toBeInTheDocument();
  });

  it('shows "offline" when ci-memory is installed but stopped', () => {
    mockConnection({ memoryInstalled: true, providerStatus: 'offline' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_OFFLINE')).toBeInTheDocument();
  });

  it('shows "not connected" only once ci-memory is ready', () => {
    mockConnection({ memoryInstalled: true, memoryReady: true, providerStatus: 'ready' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_NOT_CONNECTED')).toBeInTheDocument();
  });

  it('shows "connected" even if ci-memory is momentarily offline (a live key outranks provider status)', () => {
    mockConnection({ connected: true, memoryInstalled: true, memoryReady: false, providerStatus: 'offline' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_CONNECTED')).toBeInTheDocument();
  });

  it('does NOT show "connected" when the connection is stale and ci-memory has been uninstalled (provider absent)', () => {
    // e.g. a swallowed/raced consumer-clear after ci-memory uninstall leaves state='connected'
    // with the provider gone — the badge must report "not installed", not a green connected pill.
    mockConnection({ connected: true, memoryInstalled: false, providerStatus: 'absent' });
    render(<MemoryStatusBadge appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_BADGE_NOT_INSTALLED')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_BADGE_CONNECTED')).not.toBeInTheDocument();
  });
});
