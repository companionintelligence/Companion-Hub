import { describe, expect, it, vi } from 'vitest';
import { TailscaleController } from '../tailscale.controller';
import { servePermissionCommand, TailscaleService, type TailscaleStatus } from '../tailscale.service';

/** A host Tailscale client that is signed in, with one peer, as `getStatus` parses it. */
const CONNECTED: TailscaleStatus = {
  installed: true,
  connected: true,
  version: '1.102.3',
  hostname: 'laptop',
  nodeFqdn: 'laptop.tailxyz.ts.net',
  tailnet: 'tailxyz.ts.net',
  ip: '100.64.0.17',
  supportsServices: true,
  httpsAvailable: true,
  backendState: 'Running',
  authUrl: null,
  peers: [{ id: 'n1', nodeFqdn: 'desk.tailxyz.ts.net', hostname: 'desk', ip: '100.64.0.18', online: true, os: 'linux' }],
};

function controllerOver(status: TailscaleStatus) {
  const service = new TailscaleService();
  vi.spyOn(service, 'getStatus').mockResolvedValue(status);
  return { service, controller: new TailscaleController(service, {} as never, {} as never) };
}

describe('GET /tailscale/status', () => {
  it('passes on every field tailscaled reported, and no refusal while none stands', async () => {
    const { controller } = controllerOver(CONNECTED);

    await expect(controller.getStatus()).resolves.toEqual({ ...CONNECTED, servePermission: { denied: false, remedy: null, deniedSince: null } });
  });

  it('reports a standing refusal with the command that ends it and when it began (CI-Hub#1766)', async () => {
    const { service, controller } = controllerOver(CONNECTED);
    service.recordServePermissionDenied(new Date('2026-10-01T09:00:00.000Z'));

    await expect(controller.getStatus()).resolves.toMatchObject({
      connected: true,
      servePermission: { denied: true, remedy: servePermissionCommand(), deniedSince: '2026-10-01T09:00:00.000Z' },
    });
  });
});
