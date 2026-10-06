import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvUtils } from '@/modules/env/env.utils';
import { buildSignedForwardAuthHeaders } from '@/modules/auth/utils/forward-auth-signing';
import { MemoryConnectController } from '../memory-connect.controller';

/**
 * The wrapper-facing `/apps/:urn/state` route learns which Hub person opened the app from the
 * forward-auth headers the wrapper passes on. They are checked with the calling app's own key,
 * the one forward auth signed them with, and nothing else.
 */
describe('MemoryConnectController forwarded identity', () => {
  const urn = 'importer:ci-marketplace';
  let service: { getStatus: ReturnType<typeof vi.fn> };
  let users: { getUserByUsername: ReturnType<typeof vi.fn> };
  let appFiles: { getAppEnv: ReturnType<typeof vi.fn> };
  let controller: MemoryConnectController;

  const requestSignedWith = (secret: string) => ({
    headers: Object.fromEntries(
      Object.entries(buildSignedForwardAuthHeaders(secret, 'owner@example.com')).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  });

  beforeEach(() => {
    service = { getStatus: vi.fn().mockResolvedValue({ state: 'connected' }) };
    users = { getUserByUsername: vi.fn().mockResolvedValue({ id: 7 }) };
    appFiles = { getAppEnv: vi.fn() };
    controller = new MemoryConnectController(service as never, { warn: vi.fn() } as never, users as never, appFiles as never, new EnvUtils());
  });

  it("names the person when the headers verify under the app's own key", async () => {
    appFiles.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=app-own-key\n' });

    await controller.state(urn, 'hub.example.com', requestSignedWith('app-own-key') as never);

    expect(service.getStatus).toHaveBeenCalledWith(urn, { host: 'hub.example.com' }, '7');
  });

  it('names nobody for an app with no key of its own, whatever secret signed the headers', async () => {
    appFiles.getAppEnv.mockResolvedValue({ path: '/x', content: '' });

    await controller.state(urn, 'hub.example.com', requestSignedWith('hub-wide-secret') as never);

    expect(service.getStatus).toHaveBeenCalledWith(urn, { host: 'hub.example.com' }, null);
  });
});
