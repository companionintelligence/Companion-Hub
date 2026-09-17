/**
 * `cihub reset` must remove installed apps before it tears down the Hub and deletes its data dir.
 *
 * The runbook promised "Removes apps/data? Yes", but reset only ran `compose down` for the Hub's own
 * project and then deleted the data dir, which holds every app's bind mounts. On core-2
 * (2026-09-17) a wipe with that shape left ci-memory, OpenClaw, Hermes, and import-tools running
 * against deleted directories, calling the fresh Hub with keys it rejected (401).
 *
 * Only the process runners, the prompt, and the context lookup are replaced. The fake `docker`
 * records whether the data dir still existed at the moment of each call.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', calls: [] as string[] }));

const recordDocker = (args: string[]) => {
  state.calls.push(`${args.join(' ')} | dataDir=${existsSync(state.dataDir) ? 'present' : 'gone'}`);
};

vi.mock('../lib/cli-proc.js', () => ({
  run: vi.fn((_cmd: string, args: string[]) => recordDocker(args)),
  runBestEffort: vi.fn((_cmd: string, args: string[]) => {
    recordDocker(args);
    return true;
  }),
  runCapture: vi.fn((_cmd: string, args: string[]) => {
    recordDocker(args);
    const command = args.join(' ');
    if (command === 'ps -a --filter label=ci-os-hub.managed=true --format {{.Labels}}') {
      return { ok: true, stdout: 'ci-os-hub.managed=true,com.docker.compose.project=ci-memory_ci-marketplace' };
    }
    if (command === 'ps -aq --filter label=com.docker.compose.project=ci-memory_ci-marketplace') {
      return { ok: true, stdout: 'mem-api\nmem-db' };
    }
    return { ok: true, stdout: '' };
  }),
}));
vi.mock('../lib/cli-prompt.js', () => ({ confirmDestructiveAction: vi.fn(async () => true) }));
vi.mock('../lib/cli-repo-context.js', () => ({ isApplianceMode: () => true, requireRepoRoot: vi.fn() }));
vi.mock('../lib/cli-lifecycle.js', () => ({ startHub: vi.fn() }));
vi.mock('../lib/cli-ui.js', () => ({ dim: (text: string) => text, printMessageBox: vi.fn() }));
vi.mock('../lib/hub-context.js', () => ({
  requireRepoOrApplianceContext: vi.fn(),
  resolveHubContext: () => ({
    env: 'prod',
    appliance: true,
    envFile: path.join(state.dataDir, '.env'),
    composeFiles: [path.join(state.dataDir, 'docker-compose.prod.yml')],
    cwd: state.dataDir,
    dataDir: state.dataDir,
  }),
  composeArgsForContext: () => ['compose', '--project-name', 'ci-hub'],
  envOverridesForContext: () => ({}),
}));

import { resetHub } from '../lib/cli-teardown';

describe('cihub reset removes installed apps first', () => {
  let home: string;
  const previousHome = process.env.HOME;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cli-reset-apps-'));
    process.env.HOME = home;
    state.dataDir = path.join(home, '.local', 'share', 'companion-hub');
    state.calls = [];
    mkdirSync(path.join(state.dataDir, 'app-data', 'ci-marketplace', 'ci-memory'), { recursive: true });
    writeFileSync(path.join(state.dataDir, '.env'), 'X=1\n');
    writeFileSync(path.join(state.dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('removes app containers and volumes while the data dir they mount still exists, before compose down', async () => {
    await expect(resetHub('prod', true)).resolves.toBe(true);

    const appRemoval = state.calls.findIndex((line) => line.startsWith('rm -f mem-api mem-db'));
    const composeDown = state.calls.findIndex((line) => line.startsWith('compose --project-name ci-hub down'));
    expect(state.calls[appRemoval]).toBe('rm -f mem-api mem-db | dataDir=present');
    expect(state.calls).toContain('volume ls -q --filter label=com.docker.compose.project=ci-memory_ci-marketplace | dataDir=present');
    expect(composeDown).toBeGreaterThan(appRemoval);
    expect(existsSync(state.dataDir)).toBe(false);
  });
});
