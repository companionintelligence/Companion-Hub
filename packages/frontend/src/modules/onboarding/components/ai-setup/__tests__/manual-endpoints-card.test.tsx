import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ManualEndpointsCard } from '../manual-endpoints-card';

describe('ManualEndpointsCard', () => {
  it('names the fields as a vLLM server and shows the full example URLs', () => {
    render(<ManualEndpointsCard decodeEndpoint="" encodeEndpoint="" onDecodeEndpointChange={vi.fn()} onEncodeEndpointChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Or point at a vLLM server' })).toBeInTheDocument();
    expect(screen.getByText(/a vLLM server you already run/)).toBeInTheDocument();
    expect(screen.getByTestId('manual-decode-hint')).toHaveTextContent('http://host.docker.internal:8000');
    expect(screen.getByTestId('manual-encode-hint')).toHaveTextContent('http://host.docker.internal:11434');
  });
});
