/**
 * What `cihub doctor` and `cihub uninstall` say in their exit code.
 *
 * Both used to end in a coloured box and nothing else. `cihub doctor && cihub up` therefore walked
 * past a dead Docker daemon, and an uninstall that could not remove a directory reported success to
 * the script that ran it — the operator only learns otherwise by reading the screen.
 *
 * The other half of this is the fail/note split. Doctor is the command you run on a machine that is
 * not set up yet, so a missing env file is an answer rather than a fault; an unverified bridge port
 * is one the probe never reached, which is evidence of nothing. Neither may fail the command, or the
 * exit code goes back to being ignored.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClaimNoDeviceKey } from '../lib/hub-claim.js';
import { HubUnreachableError } from '../public-web-cli.js';
import { stripAnsi } from '../lib/cli-ui.js';

const mocks = vi.hoisted(() => ({
  checkDockerAvailable: vi.fn(() => true),
  runCapture: vi.fn(() => ({ stdout: 'Docker Compose version v2.0.0', ok: true })),
  runNetworkDoctorSection: vi.fn(async () => ({ lines: ['Duplicate DB subnets     ok'], issueCount: 0, failureCount: 0 })),
  runBridgeDoctorSection: vi.fn(async () => ({
    lines: ['Docker bridge            ok'],
    issueCount: 0,
    failureCount: 0,
    remediationCommands: [] as string[],
  })),
  runHubCleanup: vi.fn(() => ({ removedDirs: 3, skippedDirs: 0, failedDirs: 0, attemptedCommands: 2, failedCommands: 0 })),
  fetchHubClaimStatus: vi.fn(async () => ({ claimed: true, operators: 1, registered: true })),
  hubContext: {
    env: 'prod',
    appliance: true,
    envFile: '',
    composeFiles: [] as string[],
    cwd: '',
    dataDir: '',
  },
}));

vi.mock('../lib/cli-repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-repo-context.js')>()),
  checkDockerAvailable: mocks.checkDockerAvailable,
  requireRepoRoot: () => {},
}));

vi.mock('../lib/cli-proc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-proc.js')>()),
  runCapture: mocks.runCapture,
}));

vi.mock('../lib/hub-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-context.js')>()),
  resolveHubContext: () => mocks.hubContext,
  requireRepoOrApplianceContext: () => {},
}));

vi.mock('../network-diagnostics-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../network-diagnostics-cli.js')>()),
  runNetworkDoctorSection: mocks.runNetworkDoctorSection,
}));

vi.mock('../bridge-diagnostics-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge-diagnostics-cli.js')>()),
  runBridgeDoctorSection: mocks.runBridgeDoctorSection,
}));

// Mocked, not merely stubbed by the absence of a key: unmocked it would read this developer's real
// settings.json and dial a real Hub on 127.0.0.1:5002.
vi.mock('../lib/hub-claim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-claim.js')>()),
  fetchHubClaimStatus: mocks.fetchHubClaimStatus,
}));

vi.mock('../hub-cleanup-lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hub-cleanup-lib.js')>()),
  runHubCleanup: mocks.runHubCleanup,
}));

import { doctorHub, uninstallHub } from '../lib/cli-doctor.js';

/** A machine where every file doctor looks for is really there, so only the mocked checks decide. */
const dataDir = mkdtempSync(join(tmpdir(), 'cihub-doctor-'));
const envFile = join(dataDir, '.env.prod');
const composeFile = join(dataDir, 'docker-compose.prod.yml');
writeFileSync(envFile, 'API_PORT=5002\n');
writeFileSync(composeFile, 'services: {}\n');

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.exitCode = undefined;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.checkDockerAvailable.mockReturnValue(true);
  mocks.runCapture.mockReturnValue({ stdout: 'Docker Compose version v2.0.0', ok: true });
  mocks.runNetworkDoctorSection.mockResolvedValue({ lines: ['Duplicate DB subnets     ok'], issueCount: 0, failureCount: 0 });
  mocks.runBridgeDoctorSection.mockResolvedValue({
    lines: ['Docker bridge            ok'],
    issueCount: 0,
    failureCount: 0,
    remediationCommands: [],
  });
  mocks.fetchHubClaimStatus.mockResolvedValue({ claimed: true, operators: 1, registered: true });
  Object.assign(mocks.hubContext, { envFile, composeFiles: [composeFile], cwd: dataDir, dataDir });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('doctorHub exit code', () => {
  it('exits 0 when every check passes', async () => {
    await doctorHub('prod');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when Docker is not available', async () => {
    mocks.checkDockerAvailable.mockReturnValue(false);
    await doctorHub('prod');
    expect(process.exitCode).toBe(1);
  });

  it('fails when docker compose is not available', async () => {
    mocks.runCapture.mockReturnValue({ stdout: '', ok: false });
    await doctorHub('prod');
    expect(process.exitCode).toBe(1);
  });

  it('fails when a compose file is missing', async () => {
    Object.assign(mocks.hubContext, { composeFiles: [join(dataDir, 'docker-compose.gone.yml')] });
    await doctorHub('prod');
    expect(process.exitCode).toBe(1);
  });

  it('does not fail on a missing env file or root folder', async () => {
    // The state before setup, which is one of the states doctor exists to report. Failing here would
    // mean `cihub doctor` could never be run to find out what to do next.
    Object.assign(mocks.hubContext, { envFile: join(dataDir, 'nope.env'), dataDir: join(dataDir, 'nope') });
    await doctorHub('prod');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails when the bridge section reports a broken path', async () => {
    mocks.runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 blocked'],
      issueCount: 1,
      failureCount: 1,
      remediationCommands: ['sudo ufw allow ...'],
    });
    await doctorHub('prod');
    expect(process.exitCode).toBe(1);
  });

  it('does not fail on a bridge port the probe could not check', async () => {
    mocks.runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 unverified'],
      issueCount: 1,
      failureCount: 0,
      remediationCommands: [],
    });
    await doctorHub('prod');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails on a network conflict but not on orphan networks alone', async () => {
    mocks.runNetworkDoctorSection.mockResolvedValue({ lines: ['Orphan compose networks  4 unused bridge(s)'], issueCount: 4, failureCount: 0 });
    await doctorHub('prod');
    expect(process.exitCode).toBeUndefined();

    mocks.runNetworkDoctorSection.mockResolvedValue({ lines: ['Hub pool overlaps        1 conflict(s)'], issueCount: 1, failureCount: 1 });
    await doctorHub('prod');
    expect(process.exitCode).toBe(1);
  });
});

describe('uninstallHub exit code', () => {
  it('exits 0 when everything was removed', async () => {
    await uninstallHub(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails, and says incomplete, when a directory could not be removed', async () => {
    mocks.runHubCleanup.mockReturnValue({ removedDirs: 1, skippedDirs: 0, failedDirs: 2, attemptedCommands: 2, failedCommands: 0 });
    await uninstallHub(true);
    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('Uninstall incomplete');
  });

  it('fails when a cleanup command could not run', async () => {
    mocks.runHubCleanup.mockReturnValue({ removedDirs: 3, skippedDirs: 0, failedDirs: 0, attemptedCommands: 2, failedCommands: 1 });
    await uninstallHub(true);
    expect(process.exitCode).toBe(1);
  });
});

/**
 * The half-provisioned node.
 *
 * `cihub register` succeeds, the device key lands on disk, and the `user` table stays empty — so
 * every operator-authenticated call answers 409 and the machine looks, from anywhere else, like it
 * has a broken key. Twelve of sixteen fleet nodes sat in that state. `doctor` is the last thing an
 * installer runs on a node, so it is where the state has to be caught, with an exit code an
 * installer can read.
 */
describe('doctorHub operator check', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

  it('fails a Hub that is registered but has no operator', async () => {
    mocks.fetchHubClaimStatus.mockResolvedValue({ claimed: false, operators: 0, registered: true });

    await doctorHub('prod');

    expect(process.exitCode).toBe(1);
    expect(doctorText()).toContain('cihub claim');
  });

  it('does not fail a Hub that has not been registered yet', async () => {
    // Before pairing there is nothing to claim the Hub on behalf of, so "no operator" is the
    // expected state and not a fault — failing here would put a red line on every machine that has
    // not been set up, which is most of the machines doctor gets run on.
    mocks.fetchHubClaimStatus.mockResolvedValue({ claimed: false, operators: 0, registered: false });

    await doctorHub('prod');

    expect(process.exitCode).toBeUndefined();
    expect(doctorText()).toContain('cihub register');
  });

  it('reports the operator count when there is one', async () => {
    mocks.fetchHubClaimStatus.mockResolvedValue({ claimed: true, operators: 2, registered: true });

    await doctorHub('prod');

    expect(process.exitCode).toBeUndefined();
    expect(doctorText()).toContain('2 present');
  });

  it.each([
    ['the Hub is not answering', new HubUnreachableError('Cannot reach the Hub at http://127.0.0.1:5002')],
    ['this machine holds no device key', new HubClaimNoDeviceKey(['/data/state/settings.json'])],
  ])('says unknown rather than failing when %s', async (_label, error) => {
    // Not having asked is not the same as having been told no. Reporting a fault here would make
    // `cihub doctor` unusable on exactly the machines it is meant to triage.
    mocks.fetchHubClaimStatus.mockRejectedValue(error);

    await doctorHub('prod');

    expect(process.exitCode).toBeUndefined();
    expect(doctorText()).toContain('unknown');
  });
});
