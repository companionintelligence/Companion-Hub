import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManualEndpointsCard } from '../manual-endpoints-card';

describe('ManualEndpointsCard', () => {
  it('keeps the set-your-own-endpoints copy and shows the full example URLs', () => {
    render(<ManualEndpointsCard decodeEndpoint="" encodeEndpoint="" onDecodeEndpointChange={vi.fn()} onEncodeEndpointChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Or set endpoints yourself' })).toBeInTheDocument();
    expect(screen.getByText(/Leave these blank to use the engine above/)).toBeInTheDocument();
    expect(screen.getByTestId('manual-decode-hint')).toHaveTextContent('http://host.docker.internal:8000');
    expect(screen.getByTestId('manual-encode-hint')).toHaveTextContent('http://host.docker.internal:11434');
  });
});
