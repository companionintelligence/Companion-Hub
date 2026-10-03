import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OperatorsList } from './operators-list';

const query = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  data: [] as { id: number; username: string; orgRole: null; accessStatus: 'active'; membershipCheckedAt: null; localPasswordSet: boolean }[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => query,
}));

vi.mock('@/api-client/client.gen', () => ({
  client: { get: vi.fn() },
}));

describe('OperatorsList', () => {
  it('says it is loading instead of showing an empty table', () => {
    query.isPending = true;
    query.isError = false;
    query.data = [];

    render(<OperatorsList />);

    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('No one is listed on this Hub yet.')).not.toBeInTheDocument();
  });

  it('says the list is empty only after a successful fetch', () => {
    query.isPending = false;
    query.isError = false;
    query.data = [];

    render(<OperatorsList />);

    expect(screen.getByText('No one is listed on this Hub yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
