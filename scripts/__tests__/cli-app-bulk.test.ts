/**
 * `cihub app start-all|stop-all|restart-all|update-all`: what the command does with each answer.
 *
 * The exit code is the interface for a script driving this over SSH: 0 only when the Hub accepted the
 * request, non-zero for every other outcome, each with a message that names the actual problem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClaimNoDeviceKey, HubClaimRefused } from '../lib/hub-claim.js';
import { HubUnreachableError } from '../public-web-cli.js';

const mocks = vi.hoisted(() => ({
  requestBulkAppAction: vi.fn(),
}));

vi.mock('../lib/hub-bulk-apps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-bulk-apps.js')>()),
  requestBulkAppAction: mocks.requestBulkAppAction,
}));

vi.mock('../lib/hub-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-context.js')>()),
  resolveHubContext: () => ({ env: 'prod', appliance: true, envFile: '/data/.env.dev', composeFiles: [], cwd: '/data', dataDir: '/data' }),
  requireRepoOrApplianceContext: () => {},
}));

vi.mock('../lib/cli-repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-repo-context.js')>()),
  requireRepoRoot: () => {},
}));

import { runBulkAppCommand } from '../lib/cli-app-bulk.js';

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const output = () => (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
});

describe('runBulkAppCommand', () => {
  it.each(['start-all', 'stop-all', 'restart-all', 'update-all'] as const)('asks the Hub for %s and exits 0', async (action) => {
    mocks.requestBulkAppAction.mockResolvedValue(undefined);

    await runBulkAppCommand(action, []);

    expect(mocks.requestBulkAppAction).toHaveBeenCalledWith('/data/.env.dev', action);
    expect(output()).toContain('requested');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 and names the key problem when this machine has no device key', async () => {
    mocks.requestBulkAppAction.mockRejectedValue(new HubClaimNoDeviceKey(['/data/state/settings.json']));

    await expect(runBulkAppCommand('stop-all', [])).rejects.toThrow('exit:1');

    expect(output()).toContain('No device key');
    expect(output()).toContain('/data/state/settings.json');
  });

  it('exits 1 and says how to start the Hub when it is not running', async () => {
    mocks.requestBulkAppAction.mockRejectedValue(new HubUnreachableError('Cannot reach the Hub at http://127.0.0.1:5002 — fetch failed'));

    await expect(runBulkAppCommand('start-all', [])).rejects.toThrow('exit:1');

    expect(output()).toContain('Hub not reachable');
    expect(output()).toContain('cihub up');
  });

  it('exits 1 and shows the Hub’s refusal', async () => {
    mocks.requestBulkAppAction.mockRejectedValue(new HubClaimRefused(403, 'APP_ACTION_GRANT_DENIED', 'APP_ACTION_GRANT_DENIED'));

    await expect(runBulkAppCommand('stop-all', [])).rejects.toThrow('exit:1');

    expect(output()).toContain('refused');
    expect(output()).toContain('APP_ACTION_GRANT_DENIED');
    expect(output()).toContain('403');
  });

  it('exits 1 for anything else rather than swallowing it', async () => {
    mocks.requestBulkAppAction.mockRejectedValue(new Error('something unexpected'));

    await expect(runBulkAppCommand('update-all', [])).rejects.toThrow('exit:1');

    expect(output()).toContain('something unexpected');
  });
});
