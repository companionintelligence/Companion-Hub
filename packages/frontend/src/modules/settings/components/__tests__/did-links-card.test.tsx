import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DidLinksCard } from '../did-links-card';

const { mockUseOptionalUserContext, mockDidLinks, mockDidChallenge, mockDidLink, mockDidUnlink } = vi.hoisted(() => ({
  mockUseOptionalUserContext: vi.fn(),
  mockDidLinks: vi.fn(),
  mockDidChallenge: vi.fn(),
  mockDidLink: vi.fn(),
  mockDidUnlink: vi.fn(),
}));

vi.mock('@/context/user-context', () => ({
  useOptionalUserContext: () => mockUseOptionalUserContext(),
}));

vi.mock('@/api-client', () => ({
  didLinks: () => mockDidLinks(),
  didChallenge: (opts: unknown) => mockDidChallenge(opts),
  didLink: (opts: unknown) => mockDidLink(opts),
  didUnlink: (opts: unknown) => mockDidUnlink(opts),
}));

vi.mock('@/lib/copy-to-clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('DidLinksCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockUseOptionalUserContext.mockReturnValue({ didAuthEnabled: true });
    mockDidLinks.mockResolvedValue({ data: { links: [] } });
  });

  it('stays hidden when didAuthEnabled is false or user context is absent', () => {
    mockUseOptionalUserContext.mockReturnValue({ didAuthEnabled: false });
    const { rerender } = render(<DidLinksCard />);
    expect(screen.queryByTestId('did-links-card')).not.toBeInTheDocument();

    mockUseOptionalUserContext.mockReturnValue(null);
    rerender(<DidLinksCard />);
    expect(screen.queryByTestId('did-links-card')).not.toBeInTheDocument();
  });

  it('lists bound DIDs, generates and links a browser did:key pair via SIOPv2, and unlinks cleanly', async () => {
    const sampleDid = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    mockDidLinks
      .mockResolvedValueOnce({ data: { links: [] } })
      .mockResolvedValueOnce({ data: { links: [{ did: sampleDid, linkedAt: '2026-11-12T00:00:00.000Z' }] } })
      .mockResolvedValueOnce({ data: { links: [] } });
    mockDidChallenge.mockResolvedValue({
      data: {
        challengeId: '22222222-2222-2222-2222-222222222222',
        nonce: 'nonce-link-1',
        audience: 'urn:ci-hub:test',
        purpose: 'link',
        expiresAt: Date.now() + 60_000,
      },
    });
    mockDidLink.mockResolvedValue({ data: { success: true, did: sampleDid } });
    mockDidUnlink.mockResolvedValue({ data: { success: true, did: sampleDid } });

    const user = userEvent.setup();
    render(<DidLinksCard />);

    expect(await screen.findByTestId('did-links-empty')).toBeInTheDocument();

    await user.click(screen.getByTestId('link-browser-did-btn'));

    await waitFor(() => {
      expect(mockDidChallenge).toHaveBeenCalledWith({ body: { purpose: 'link' } });
      expect(mockDidLink).toHaveBeenCalledWith({
        body: expect.objectContaining({
          challengeId: '22222222-2222-2222-2222-222222222222',
          idToken: expect.stringMatching(/^eyJ[^.]+\.[^.]+\.[^.]+$/),
        }),
      });
    });

    expect(await screen.findByText(sampleDid)).toBeInTheDocument();
    await user.click(screen.getByTestId(`unlink-did-${sampleDid}`));
    expect(mockDidUnlink).toHaveBeenCalledWith({ body: { did: sampleDid } });
    expect(await screen.findByTestId('did-links-empty')).toBeInTheDocument();
  });
});
