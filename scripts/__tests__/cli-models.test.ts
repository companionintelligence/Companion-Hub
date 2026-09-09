/**
 * `cihub models` and `cihub public-web repair` — commands that reported a problem and exited 0.
 *
 * `models install llama3` on a machine with no Ollama container printed a box and stopped, so the
 * fleet script that ran it moved on believing the model was there. `public-web repair` marked its
 * failures with a ✗ and used them only to tint the box.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PUBLIC_WEB_REPAIR_FAIL_PREFIX, PUBLIC_WEB_REPAIR_OK_PREFIX } from '../public-web-cli.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  findComposeName: vi.fn(() => ''),
  runPublicWebRepair: vi.fn(async () => [] as string[]),
}));

vi.mock('../lib/cli-proc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-proc.js')>()),
  run: mocks.run,
}));

vi.mock('../lib/cli-doctor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-doctor.js')>()),
  findComposeName: mocks.findComposeName,
}));

vi.mock('../lib/cli-repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-repo-context.js')>()),
  requireRepoRoot: () => {},
}));

vi.mock('../lib/cli-compose-env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-compose-env.js')>()),
  getEnvFileOrExit: () => '.env.local',
}));

// `publicWebRepairHasFailures` stays real: it is the rule under test, and the repair lines below are
// the ones the Hub actually returns.
vi.mock('../public-web-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-web-cli.js')>()),
  runPublicWebRepair: mocks.runPublicWebRepair,
}));

import { runModelsCommand, runPublicWebCommand } from '../lib/cli-models.js';

beforeEach(() => {
  process.exitCode = undefined;
  mocks.run.mockReset();
  mocks.findComposeName.mockReset().mockReturnValue('');
  mocks.runPublicWebRepair.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('models without a running Ollama', () => {
  it('fails instead of reporting the model handled', () => {
    runModelsCommand(['install', 'llama3']);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 once the container is there', () => {
    mocks.findComposeName.mockReturnValue('ci-hub-ollama-1');
    runModelsCommand(['list']);
    expect(process.exitCode).toBeUndefined();
  });
});

describe('public-web repair', () => {
  it('fails when a repair line reports a failure', async () => {
    mocks.runPublicWebRepair.mockResolvedValue([`${PUBLIC_WEB_REPAIR_FAIL_PREFIX} app:store: repair failed`]);
    await runPublicWebCommand(['repair']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 when every app repaired', async () => {
    mocks.runPublicWebRepair.mockResolvedValue([`${PUBLIC_WEB_REPAIR_OK_PREFIX} app:store → host.example.com`]);
    await runPublicWebCommand(['repair']);
    expect(process.exitCode).toBeUndefined();
  });
});
