import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsReadService } from '@/modules/apps/apps-read.service';
import { buildSignedConnectHeaders } from '@/modules/auth/utils/connect-request-signing';
import { EnvUtils } from '@/modules/env/env.utils';
import { AgentNotifyController } from '../agent-notify.controller';

/**
 * Memory's doorbell (`POST /api/agent-notify/wake`) is signed with that Memory's own connect key.
 * It used to be the Hub-wide secret, which env generation copied into Memory, so anything inside
 * a Memory container could ring it as the Hub's own trusted caller (2026-11-20 audit).
 */

const HUB_WIDE = 'hub-wide-secret';
const WAKE_PATH = '/api/agent-notify/wake';
const BODY = { appUrn: 'ci-openclaw:ci-marketplace', jobId: 'job-1' };

function makeController(memoryKey: string | null, installed = [{ appName: 'ci-memory', appStoreSlug: 'ci-marketplace' }]) {
  const agentNotifyService = { wakeApp: vi.fn().mockResolvedValue(true) };
  const config = { get: vi.fn((key: string) => (key === 'forwardAuthSecret' ? HUB_WIDE : undefined)) };
  const services = new Map<unknown, unknown>([
    [AppsReadService, { getInstalledAppsLite: vi.fn().mockResolvedValue(installed) }],
    [AppFilesManager, { getAppEnv: vi.fn().mockResolvedValue({ path: '/x', content: memoryKey ? `KEY=${memoryKey}` : '' }) }],
    [EnvUtils, { envStringToMap: (content: string) => new Map(content ? [['CI_HUB_FORWARD_AUTH_SECRET', content.slice(4)]] : []) }],
  ]);
  const moduleRef = { get: vi.fn((token: unknown) => services.get(token)) };
  const controller = new AgentNotifyController(agentNotifyService as never, config as never, moduleRef as never);

  return { controller, agentNotifyService };
}

/** A wake request signed with `secret`. */
function wakeSignedWith(secret: string) {
  const headers = buildSignedConnectHeaders(secret, 'POST', WAKE_PATH, BODY) as unknown as Record<string, string>;
  const req = { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] };

  return req as never;
}

describe('AgentNotifyController.wake', () => {
  it('rings the app when the installed Memory signed with its own key', async () => {
    const { controller, agentNotifyService } = makeController('memory-own-key');

    await expect(controller.wake(wakeSignedWith('memory-own-key'), BODY)).resolves.toEqual({ ok: true });
    expect(agentNotifyService.wakeApp).toHaveBeenCalledWith(BODY.appUrn, { jobId: BODY.jobId });
  });

  it('refuses a wake signed with the Hub-wide secret', async () => {
    const { controller, agentNotifyService } = makeController('memory-own-key');

    await expect(controller.wake(wakeSignedWith(HUB_WIDE), BODY)).rejects.toThrow(UnauthorizedException);
    expect(agentNotifyService.wakeApp).not.toHaveBeenCalled();
  });

  it.each([
    ['still holds the Hub-wide value', HUB_WIDE],
    ['has no key', null],
  ])('refuses every wake while the installed Memory %s', async (_label, memoryKey) => {
    const { controller, agentNotifyService } = makeController(memoryKey);

    await expect(controller.wake(wakeSignedWith(HUB_WIDE), BODY)).rejects.toThrow(UnauthorizedException);
    expect(agentNotifyService.wakeApp).not.toHaveBeenCalled();
  });

  it('takes no key from an app that is not the official Companion Memory', async () => {
    const { controller, agentNotifyService } = makeController('its-key', [{ appName: 'ci-memory', appStoreSlug: 'other-store' }]);

    await expect(controller.wake(wakeSignedWith('its-key'), BODY)).rejects.toThrow(UnauthorizedException);
    expect(agentNotifyService.wakeApp).not.toHaveBeenCalled();
  });
});
