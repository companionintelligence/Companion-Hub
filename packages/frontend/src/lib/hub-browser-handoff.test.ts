import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ post: vi.fn(), openExternal: vi.fn(), getTauriInvoke: vi.fn() }));
vi.mock('@/api-client/client.gen', () => ({ client: { post: (...args: unknown[]) => h.post(...args) } }));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: h.openExternal }));
vi.mock('@/lib/helpers/tauri-invoke', () => ({ getTauriInvoke: h.getTauriInvoke }));

import { openExternalWithHubSession } from './hub-browser-handoff';

const TARGET = 'https://ci-hermes-core-2-org.companionintelligence.com/';

describe('openExternalWithHubSession', () => {
  afterEach(() => {
    h.post.mockReset();
    h.openExternal.mockReset();
    h.getTauriInvoke.mockReset();
  });

  it('web (non-Tauri): opens the target directly without minting a handoff', async () => {
    h.getTauriInvoke.mockReturnValue(null);

    await openExternalWithHubSession(TARGET);

    expect(h.post).not.toHaveBeenCalled();
    expect(h.openExternal).toHaveBeenCalledWith(TARGET);
  });

  it('desktop: mints a ticket and opens the returned Hub handoff URL instead of the bare target', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn());
    const handoffUrl = 'https://hub-core-2-org.companionintelligence.com/api/auth/browser-handoff?ticket=abc';
    h.post.mockResolvedValue({ data: { url: handoffUrl } });

    await openExternalWithHubSession(TARGET);

    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/auth/browser-handoff/mint', body: { next: TARGET } }));
    expect(h.openExternal).toHaveBeenCalledWith(handoffUrl);
    expect(h.openExternal).not.toHaveBeenCalledWith(TARGET);
  });

  it('desktop: fails open to the bare target when no Hub origin is known (url:null)', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn());
    h.post.mockResolvedValue({ data: { url: null } });

    await openExternalWithHubSession(TARGET);

    expect(h.openExternal).toHaveBeenCalledWith(TARGET);
  });

  it('desktop: fails open to the bare target when minting throws', async () => {
    h.getTauriInvoke.mockReturnValue(vi.fn());
    h.post.mockRejectedValue(new Error('network down'));

    await openExternalWithHubSession(TARGET);

    expect(h.openExternal).toHaveBeenCalledWith(TARGET);
  });
});
