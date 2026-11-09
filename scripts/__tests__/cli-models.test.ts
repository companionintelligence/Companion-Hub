/**
 * `cihub models` and `cihub public-web repair` — commands that reported a problem and exited 0.
 *
 * `models install llama3` on a machine with no Ollama container printed a box and stopped, so the
 * fleet script that ran it moved on believing the model was there. `public-web repair` marked its
 * failures with a ✗ and used them only to tint the box.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PUBLIC_WEB_REPAIR_FAIL_PREFIX, PUBLIC_WEB_REPAIR_OK_PREFIX } from '../public-web-cli.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  commandExists: vi.fn(() => false),
  findComposeName: vi.fn(() => ''),
  runPublicWebRepair: vi.fn(async () => [] as string[]),
  resolveHubContext: vi.fn(),
}));

vi.mock('../lib/cli-proc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-proc.js')>()),
  run: mocks.run,
  commandExists: mocks.commandExists,
}));

vi.mock('../lib/hub-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-context.js')>()),
  requireRepoOrApplianceContext: () => {},
  resolveHubContext: mocks.resolveHubContext,
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

import { runModelsCommand, runPublicWebCommand, setMcpState } from '../lib/cli-models.js';

beforeEach(() => {
  process.exitCode = undefined;
  mocks.run.mockReset();
  mocks.findComposeName.mockReset().mockReturnValue('');
  mocks.commandExists.mockReset().mockReturnValue(false);
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

  it("uses the host's Ollama when the Hub has no container, as on an installed Hub", () => {
    mocks.commandExists.mockReturnValue(true);

    runModelsCommand(['list']);
    runModelsCommand(['install', 'llama3']);
    runModelsCommand(['rm', 'llama3']);

    expect(mocks.run.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['ollama', ['list']],
      ['ollama', ['pull', 'llama3']],
      ['ollama', ['rm', 'llama3']],
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prefers the Hub's container over a host Ollama", () => {
    mocks.commandExists.mockReturnValue(true);
    mocks.findComposeName.mockReturnValue('ci-hub-ollama-1');

    runModelsCommand(['list']);

    expect(mocks.run).toHaveBeenCalledWith('docker', ['exec', 'ci-hub-ollama-1', 'ollama', 'list']);
  });
});

describe('mcp on an installed Hub', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cihub-mcp-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the env file the Hub reads and says a restart applies it', () => {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'MCP_ENABLED=true\nCI_CLOUD_URL=https://portal.example.test\n');
    mocks.resolveHubContext.mockReturnValue({ env: 'prod', appliance: true, envFile, composeFiles: [], cwd: dir, dataDir: dir });
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});

    setMcpState('prod', false);

    const written = readFileSync(envFile, 'utf-8');
    expect(written).toContain('MCP_ENABLED=false');
    expect(written).toContain('CI_CLOUD_URL=https://portal.example.test');
    const output = printed.mock.calls.flat().join('\n');
    expect(output).toContain(envFile);
    expect(output).toContain('https://portal.example.test');
    expect(output).toContain('restart');
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
