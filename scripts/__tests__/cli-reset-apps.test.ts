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
 *
 * The stray container is beta-max's case (2026-09-22): started with `docker run` under a Hub-style
 * app name, attached to ci-hub_network, carrying no label the Hub sets. A label-only reset could not
 * see it, and neither could the fresh Hub database.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', calls: [] as string[], dockerDown: false }));

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
    if (state.dockerDown) {
      return { ok: false, stdout: '' };
    }
    if (command === 'ps -a --filter label=ci-os-hub.managed=true --format {{.Labels}}') {
      return { ok: true, stdout: 'ci-os-hub.managed=true,com.docker.compose.project=ci-memory_ci-marketplace' };
    }
    if (command === 'ps -a --filter label=com.docker.compose.project=ci-memory_ci-marketplace --format {{.Names}}') {
      return { ok: true, stdout: 'mem-api\nmem-db' };
    }
    if (command.startsWith('ps -a --filter network=ci-hub_network ')) {
      return {
        ok: true,
        stdout: 'ci-hub com.docker.compose.project=ci-hub\nci-hermes_ci-marketplace-ci-hermes-1 org.opencontainers.image.revision=345cd2b',
      };
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

import { confirmDestructiveAction } from '../lib/cli-prompt.js';
import { cleanHub, resetHub } from '../lib/cli-teardown';
import { printMessageBox } from '../lib/cli-ui.js';

const STRAY = 'ci-hermes_ci-marketplace-ci-hermes-1';
const removals = () => state.calls.filter((line) => /^(rm |volume rm |network rm |compose )/.test(line));

describe('cihub reset and cihub clean remove installed apps first', () => {
  let home: string;
  const previousHome = process.env.HOME;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cli-reset-apps-'));
    process.env.HOME = home;
    state.dataDir = path.join(home, '.local', 'share', 'companion-hub');
    state.calls = [];
    state.dockerDown = false;
    vi.clearAllMocks();
    mkdirSync(path.join(state.dataDir, 'app-data', 'ci-marketplace', 'ci-memory'), { recursive: true });
    writeFileSync(path.join(state.dataDir, '.env'), 'X=1\n');
    writeFileSync(path.join(state.dataDir, 'docker-compose.prod.yml'), 'services: {}\n');
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    process.exitCode = undefined;
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
    // The clean step inside reset does not sweep a second time.
    expect(state.calls.filter((line) => line.startsWith('rm -f mem-api mem-db'))).toHaveLength(1);
  });

  it('removes a container on the Hub network that carries no Hub label, before compose down, and not the Hub itself', async () => {
    await expect(resetHub('prod', true)).resolves.toBe(true);

    const strayRemoval = state.calls.indexOf(`rm -f ${STRAY} | dataDir=present`);
    const composeDown = state.calls.findIndex((line) => line.startsWith('compose --project-name ci-hub down'));
    expect(strayRemoval).toBeGreaterThan(-1);
    expect(composeDown).toBeGreaterThan(strayRemoval);
    const removedNames = state.calls.filter((line) => line.startsWith('rm -f ')).flatMap((line) => line.split(' | ')[0].split(' ').slice(2));
    expect(removedNames).not.toContain('ci-hub');
  });

  it('lists the apps and the stray container before it asks', async () => {
    await resetHub('prod', false);

    const box = vi.mocked(printMessageBox).mock.calls[0];
    expect(box[0]).toBe('Apps and containers this reset removes');
    expect(box[1]).toEqual(expect.arrayContaining(['ci-memory_ci-marketplace: mem-api, mem-db', `  ${STRAY}`]));
    expect(vi.mocked(printMessageBox).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(confirmDestructiveAction).mock.invocationCallOrder[0]);
  });

  it('--dry-run lists the app containers it would remove and removes nothing', async () => {
    await expect(resetHub('prod', false, true)).resolves.toBe(false);

    expect(removals()).toEqual([]);
    expect(confirmDestructiveAction).not.toHaveBeenCalled();
    expect(existsSync(state.dataDir)).toBe(true);
    const [plannedBox, dryRunBox] = vi.mocked(printMessageBox).mock.calls;
    expect(plannedBox[0]).toBe('Apps and containers this reset would remove');
    expect(plannedBox[1]).toEqual([
      'ci-memory_ci-marketplace: mem-api, mem-db',
      'On the Hub network but not installed by the Hub (container only):',
      `  ${STRAY}`,
    ]);
    expect(dryRunBox[0]).toBe('Dry run: nothing was removed');
    expect(dryRunBox[1]).toContain(`  ${state.dataDir}`);
  });

  it('stops before removing anything when Docker cannot list containers', async () => {
    state.dockerDown = true;

    await expect(resetHub('prod', true)).resolves.toBe(false);

    expect(removals()).toEqual([]);
    expect(existsSync(state.dataDir)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('cihub clean removes app containers while the data dir still exists, and keeps their volumes', () => {
    // `cihub down` stops only the Hub project, so `cihub down && cihub clean` used to delete the
    // bind sources of apps that were still running, the core-2 failure.
    cleanHub('prod');

    expect(state.calls).toContain('rm -f mem-api mem-db | dataDir=present');
    expect(state.calls.some((line) => line.startsWith('volume '))).toBe(false);
    expect(existsSync(state.dataDir)).toBe(false);
  });
});
