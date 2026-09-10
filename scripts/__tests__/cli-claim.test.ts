/**
 * `cihub claim`: what it does with each answer a Hub can give.
 *
 * The exit code is the whole interface here — this command runs inside `cihub fleet install`, over
 * `ssh -n`, on fourteen machines nobody is watching. Two behaviours matter more than the boxes it
 * prints: a Hub that is already claimed must not fail the install (or a replayed run breaks on the
 * one step that succeeded), and a Hub that refused for any OTHER reason must not exit 0 (or an
 * unclaimed node is reported as provisioned, which is how twelve of them got there).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClaimNoDeviceKey, HubClaimRefused } from '../lib/hub-claim.js';
import { HubUnreachableError } from '../public-web-cli.js';

const mocks = vi.hoisted(() => ({
  submitHubClaim: vi.fn(),
}));

vi.mock('../lib/hub-claim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-claim.js')>()),
  submitHubClaim: mocks.submitHubClaim,
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

import { claimHub, resolveClaimEmail } from '../lib/cli-claim.js';

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

describe('claimHub', () => {
  it('reports the operator it created', async () => {
    mocks.submitHubClaim.mockResolvedValue({ claimed: true, username: 'owner@example.com' });

    await claimHub('prod', { email: 'owner@example.com' });

    expect(mocks.submitHubClaim).toHaveBeenCalledWith('/data/.env.dev', 'owner@example.com');
    expect(output()).toContain('owner@example.com');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('treats an already-claimed Hub as done, not as a failure', async () => {
    // The idempotency the installer depends on. A 409 here is the Hub agreeing with us.
    mocks.submitHubClaim.mockRejectedValue(new HubClaimRefused(409, 'AUTH_ERROR_HUB_ALREADY_CLAIMED', 'AUTH_ERROR_HUB_ALREADY_CLAIMED'));

    await claimHub('prod', { email: 'owner@example.com' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(output()).toContain('Already claimed');
  });

  it('does not report an unregistered Hub as claimed', async () => {
    // Same 409, opposite meaning: nothing was created and the node is not provisioned. Exiting 0
    // here would put a silently unclaimed machine in the "installed" column.
    mocks.submitHubClaim.mockRejectedValue(new HubClaimRefused(409, 'AUTH_ERROR_HUB_NOT_REGISTERED', 'AUTH_ERROR_HUB_NOT_REGISTERED'));

    await expect(claimHub('prod', { email: 'owner@example.com' })).rejects.toThrow('exit:1');
    expect(output()).toContain('cihub register');
  });

  it('says the key is missing from THIS machine, not that the Hub refused', async () => {
    // Without the key the Hub answers the same 401 a stranger gets. Reporting that as the Hub's
    // verdict is precisely the misdiagnosis this whole change exists to end, so the CLI refuses
    // before the request and names the files it looked in.
    mocks.submitHubClaim.mockRejectedValue(
      new HubClaimNoDeviceKey(['/data/state/settings.json', '/home/ci/.local/share/companion-hub/state/settings.json']),
    );

    await expect(claimHub('prod', { email: 'owner@example.com' })).rejects.toThrow('exit:1');
    expect(output()).toContain('/data/state/settings.json');
    expect(output()).toContain('No device key');
  });

  it('tells the operator to start the Hub when nothing answered', async () => {
    mocks.submitHubClaim.mockRejectedValue(new HubUnreachableError('Cannot reach the Hub at http://127.0.0.1:5002 — ECONNREFUSED'));

    await expect(claimHub('prod', { email: 'owner@example.com' })).rejects.toThrow('exit:1');
    expect(output()).toContain('cihub up');
  });

  it('exits non-zero on an answer it does not recognise', async () => {
    // A future refusal, or a proxy in the way. Unknown must never fall through to success.
    mocks.submitHubClaim.mockRejectedValue(new HubClaimRefused(500, undefined, 'Internal Server Error'));

    await expect(claimHub('prod', { email: 'owner@example.com' })).rejects.toThrow('exit:1');
  });
});

describe('resolveClaimEmail', () => {
  it('refuses with exit 2 when there is no terminal and no --email', async () => {
    // `ssh -n` has no TTY by construction. A readline call here reads a closed stdin and never
    // settles — the exact failure `cihub register` had before it learned to refuse.
    await expect(resolveClaimEmail(undefined, false)).rejects.toThrow('exit:2');
    expect(output()).toContain('--email');
  });

  it('refuses a malformed address before it reaches the Hub', async () => {
    await expect(resolveClaimEmail('not-an-email', false)).rejects.toThrow('exit:2');
  });

  it('passes a supplied address through, trimmed', async () => {
    await expect(resolveClaimEmail('  owner@example.com ', false)).resolves.toBe('owner@example.com');
  });
});
