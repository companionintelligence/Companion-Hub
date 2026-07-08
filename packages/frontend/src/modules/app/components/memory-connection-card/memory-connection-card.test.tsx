import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, useMutation, useQueryClient } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

// t returns the key, so assertions target the i18n keys directly.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery, useMutation, useQueryClient }));
vi.mock('@/api-client/client.gen', () => ({ client: { get: vi.fn(), post: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MemoryConnectionCard } from './memory-connection-card';

type Status = {
  applicable: boolean;
  memoryInstalled: boolean;
  state: 'unconfigured' | 'connected' | 'skipped' | 'manual';
  connectUrl: string | null;
};

function mockStatus(data: Status | null, isLoading = false) {
  useQuery.mockReturnValue({ data, isLoading });
}

describe('MemoryConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueryClient.mockReturnValue({ invalidateQueries: vi.fn() });
    useMutation.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('renders nothing while the status is loading', () => {
    mockStatus(null, true);
    const { container } = render(<MemoryConnectionCard appUrn="ci-openclaw:local" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-memory app (not applicable)', () => {
    mockStatus({ applicable: false, memoryInstalled: true, state: 'unconfigured', connectUrl: 'https://h/x' });
    const { container } = render(<MemoryConnectionCard appUrn="some-app:local" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Not connected + a Connect action when unconfigured and memory is installed', () => {
    mockStatus({ applicable: true, memoryInstalled: true, state: 'unconfigured', connectUrl: 'https://hub/start' });
    render(<MemoryConnectionCard appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_STATUS_NOT_CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_ACTION_CONNECT')).toBeInTheDocument();
  });

  it('shows Connected + a Disconnect action when connected', () => {
    mockStatus({ applicable: true, memoryInstalled: true, state: 'connected', connectUrl: 'https://hub/start' });
    render(<MemoryConnectionCard appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_STATUS_CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('MEMORY_CONNECT_ACTION_DISCONNECT')).toBeInTheDocument();
  });

  it('prompts to install Companion Memory when it is not installed', () => {
    mockStatus({ applicable: true, memoryInstalled: false, state: 'unconfigured', connectUrl: null });
    render(<MemoryConnectionCard appUrn="ci-openclaw:local" />);
    expect(screen.getByText('MEMORY_CONNECT_NOT_INSTALLED')).toBeInTheDocument();
    expect(screen.queryByText('MEMORY_CONNECT_ACTION_CONNECT')).not.toBeInTheDocument();
  });
});
