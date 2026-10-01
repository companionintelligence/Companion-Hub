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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubClaimNoDeviceKey } from '../lib/hub-claim.js';
import { RegistrationPhaseRouteMissing, type RegistrationPhaseResponse } from '../lib/register-hub.js';
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
  fetchRegistrationPhase: vi.fn(
    async (): Promise<RegistrationPhaseResponse> => ({
      phase: 'publicly_ready',
      registered: true,
      degradedReasons: [],
      lastCheckIn: { at: new Date().toISOString(), httpStatus: 200, code: null, error: null },
      consecutiveCheckInFailures: 0,
    }),
  ),
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

// Mocked so a developer machine's own /etc/machine-id cannot decide these results either way.
const deviceIdMocks = vi.hoisted(() => ({
  runDeviceIdDoctorSection: vi.fn(() => ({ lines: ['Device ID            not set'], failureCount: 0 })),
}));
vi.mock('../lib/device-id-doctor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/device-id-doctor.js')>()),
  runDeviceIdDoctorSection: deviceIdMocks.runDeviceIdDoctorSection,
}));

// Mocked, not merely stubbed by the absence of a key: unmocked it would read this developer's real
// settings.json and dial a real Hub on 127.0.0.1:5002.
vi.mock('../lib/hub-claim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hub-claim.js')>()),
  fetchHubClaimStatus: mocks.fetchHubClaimStatus,
}));

// Mocked for the same reason as hub-claim: unmocked, doctor would read a live Hub on this machine.
vi.mock('../lib/register-hub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/register-hub.js')>()),
  fetchRegistrationPhase: mocks.fetchRegistrationPhase,
}));

vi.mock('../hub-cleanup-lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hub-cleanup-lib.js')>()),
  runHubCleanup: mocks.runHubCleanup,
}));

// Mocked for the same reason as device-id: unmocked, the CLI-vs-stack line would read whatever
// containers happen to be running on the machine the suite runs on.
const skewMocks = vi.hoisted(() => ({
  gatherSkew: vi.fn(() => ({
    cli: { version: '0.2.73', revision: null },
    stack: { container: 'ci-hub', reference: 'ghcr.io/companionintelligence/ci-hub:0.2.73', version: '0.2.73', revision: null },
    channel: { kind: 'standalone' as const, path: '/usr/local/bin/cihub' },
    verdict: { kind: 'match' as const, how: 'version' as const, cli: '0.2.73', stack: '0.2.73' },
    report: { severity: 'ok' as const, headline: 'cihub 0.2.73 matches the running stack', lines: ['cihub 0.2.73 matches the running stack'] },
  })),
}));
vi.mock('../lib/cli-version-skew.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-version-skew.js')>()),
  gatherSkew: skewMocks.gatherSkew,
}));

// Same reason again: the image-pin line reads the running container and the env file compose named,
// and neither is a property of the machine the suite happens to run on.
const pinMocks = vi.hoisted(() => ({
  inspectImagePin: vi.fn(() => ({
    envFile: '/data/.env',
    fromCompose: true,
    declared: undefined as string | undefined,
    drift: { kind: 'not-running' as const },
    report: { severity: 'ok' as const, headline: 'no Hub container running, so there is no image to compare the pin against', lines: [] },
  })),
}));
vi.mock('../lib/cli-image-pin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-image-pin.js')>()),
  inspectImagePin: pinMocks.inspectImagePin,
}));

import {
  describeCheckoutTarget,
  describeImagePinSection,
  describeRegistrationPhase,
  describeVersionSkewSection,
  doctorHub,
  readRunningHubOrigin,
  uninstallHub,
} from '../lib/cli-doctor.js';
import { compareDeclaredToRunning, describePinDrift } from '../lib/cli-image-pin.js';
import { classifyCliInstall, compareBuilds, describeSkew, type SkewSnapshot } from '../lib/cli-version-skew.js';

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
  mocks.fetchRegistrationPhase.mockResolvedValue({
    phase: 'publicly_ready',
    registered: true,
    degradedReasons: [],
    lastCheckIn: { at: new Date().toISOString(), httpStatus: 200, code: null, error: null },
    consecutiveCheckInFailures: 0,
  });
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

  it('fails on a DEVICE_ID copied from another machine, reading the env file doctor was pointed at', async () => {
    // beta-red and beta-nas: one DEVICE_ID, two machines, and a clean doctor on both.
    deviceIdMocks.runDeviceIdDoctorSection.mockReturnValueOnce({ lines: ['Device ID            copied from another machine'], failureCount: 1 });

    await doctorHub('prod');

    expect(deviceIdMocks.runDeviceIdDoctorSection).toHaveBeenCalledWith(envFile);
    expect(process.exitCode).toBe(1);
    expect(stripAnsi(log.mock.calls.flat().join('\n'))).toContain('copied from another machine');
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

/**
/**
 * The registration phase and the last Portal check-in.
 *
 * On 2026-09-17 five paired fleet Hubs had device keys Portal no longer accepted, for up to a week,
 * and every one of them passed doctor: the stack ran, so nothing on the machine looked wrong. The
 * phase comes from `GET /api/registration/phase`, which sends no check-in, so running doctor does
 * not change the Portal `last_seen` it reports on.
 */
describe('doctorHub registration check', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  const now = Date.parse('2026-09-17T09:30:00.000Z');

  it('fails a Hub whose device key Portal rejects, and says to pair again', async () => {
    mocks.fetchRegistrationPhase.mockResolvedValue({
      phase: 'degraded',
      registered: true,
      degradedReasons: ['portal_rejected'],
      lastCheckIn: { at: '2026-09-17T09:15:00.000Z', httpStatus: 401, code: 'UNAUTHORIZED', error: 'HTTP 401: Invalid Device Key' },
      consecutiveCheckInFailures: 0,
    });

    await doctorHub('prod');

    expect(process.exitCode).toBe(1);
    expect(doctorText()).toContain('degraded (portal_rejected)');
    expect(doctorText()).toContain('cihub register --code');
    expect(doctorText()).toContain('HTTP 401 UNAUTHORIZED');
  });

  it('notes, without failing, a Portal that is only failing transiently', () => {
    const result = describeRegistrationPhase(
      {
        phase: 'degraded',
        registered: true,
        degradedReasons: ['cloud_validation_failed'],
        lastCheckIn: { at: '2026-09-17T09:29:00.000Z', httpStatus: null, code: null, error: 'timeout of 5000ms exceeded' },
        consecutiveCheckInFailures: 3,
      },
      now,
    );

    expect(result.failureCount).toBe(0);
    expect(result.issueCount).toBe(1);
    expect(stripAnsi(result.lines.join('\n'))).toContain('no response');
    expect(stripAnsi(result.lines.join('\n'))).toContain('timeout of 5000ms exceeded, 60s ago');
  });

  it('names a rejected key the Hub is still confirming, since the phase does not show it yet', () => {
    // The Hub waits ten minutes before it believes a 401, because Portal answers a D1 read error the
    // same way; an operator running doctor straight after an update would otherwise see only a note.
    const result = describeRegistrationPhase(
      {
        phase: 'degraded',
        registered: true,
        degradedReasons: ['cloud_validation_failed'],
        lastCheckIn: { at: '2026-09-17T09:29:00.000Z', httpStatus: 401, code: 'UNAUTHORIZED', error: 'HTTP 401: Invalid Device Key' },
        consecutiveCheckInFailures: 1,
      },
      now,
    );

    expect(result.failureCount).toBe(0);
    expect(stripAnsi(result.lines.join('\n'))).toContain('Portal refuses the device key; if that lasts 10 min, pair again');
  });

  it('reports an accepted check-in and how long ago it was', () => {
    const result = describeRegistrationPhase(
      {
        phase: 'publicly_ready',
        registered: true,
        degradedReasons: [],
        lastCheckIn: { at: '2026-09-17T09:15:00.000Z', httpStatus: 200, code: null, error: null },
        consecutiveCheckInFailures: 0,
      },
      now,
    );

    expect(result).toMatchObject({ failureCount: 0, issueCount: 0 });
    expect(stripAnsi(result.lines.join('\n'))).toContain('accepted (HTTP 200)  15m ago');
  });

  it('does not fail an unregistered Hub, which is the state before setup', async () => {
    mocks.fetchRegistrationPhase.mockResolvedValue({ phase: 'unregistered', registered: false, degradedReasons: [], lastCheckIn: null });

    await doctorHub('prod');

    expect(process.exitCode).toBeUndefined();
    expect(doctorText()).toContain('unregistered');
  });

  it.each([
    ['the Hub is not answering', new HubUnreachableError('Cannot reach the Hub at http://127.0.0.1:5002'), 'Hub not answering'],
    ['the Hub build predates the phase route', new RegistrationPhaseRouteMissing(), 'predates /api/registration/phase'],
  ])('says unknown rather than failing when %s', async (_label, error, why) => {
    mocks.fetchRegistrationPhase.mockRejectedValue(error);

    await doctorHub('prod');

    expect(process.exitCode).toBeUndefined();
    expect(doctorText()).toContain(why);
  });
});

/**
 * A tunnel token only turns the tunnel on beside the backend's `registration.json`. A token without
 * it is what an uninstalled or reset Hub leaves behind, so doctor names that state instead of
 * reporting a usable token.
 */
describe('doctorHub tunnel token line', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  let base: string;
  let tunnelDir: string;

  beforeEach(() => {
    // Nested so the data dir's sibling `../tunnel` stays inside this test's own temp folder.
    base = mkdtempSync(join(tmpdir(), 'cihub-doctor-tunnel-'));
    const hubDir = join(base, 'hub');
    tunnelDir = join(base, 'tunnel');
    mkdirSync(hubDir, { recursive: true });
    mkdirSync(tunnelDir, { recursive: true });
    Object.assign(mocks.hubContext, { dataDir: hubDir });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reports absent when there is no token', async () => {
    await doctorHub('prod');
    expect(doctorText()).toMatch(/Tunnel token\s+\S*\s*absent/);
  });

  it('calls out a token without the registration marker', async () => {
    writeFileSync(join(tunnelDir, 'token'), 'leftover-token\n');
    await doctorHub('prod');
    expect(doctorText()).toContain('present, no registration marker (tunnel stays off)');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports present for a registered token', async () => {
    writeFileSync(join(tunnelDir, 'token'), 'registered-token\n');
    writeFileSync(join(tunnelDir, 'registration.json'), '{"tunnelId":"tunnel-1","writtenAt":"2026-09-17T00:00:00.000Z"}');
    await doctorHub('prod');
    const text = doctorText();
    expect(text).toMatch(/Tunnel token\s+\S*\s*present/);
    expect(text).not.toContain('no registration marker');
  });
});

/**
 * The CLI-vs-stack line: the one mismatch doctor could not see.
 *
 * beta-max, 2026-09-21 — `cihub version` 0.2.72, an untagged stack image, and a green doctor while
 * `cihub pool ceiling` answered `Unknown pool subcommand`. The fail/note split matters here as much
 * as anywhere else in this file: a `:dev` node whose image carries no release tag is normal, and
 * failing it would put a red line on every development machine in the fleet.
 */
describe('CLI vs stack', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  const channel = classifyCliInstall('/usr/local/bin/cihub');
  const snapshot = (cliVersion: string, stackVersion: string | null, reference: string, revision: string | null = null): SkewSnapshot => {
    const cli = { version: cliVersion, revision: null };
    const stack = { container: 'ci-hub', reference, version: stackVersion, revision };
    const verdict = compareBuilds(cli, stack);
    return { cli, stack, channel, verdict, report: describeSkew(verdict, channel) };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('says nothing but the good news when both name the same release', () => {
    const section = describeVersionSkewSection(snapshot('0.2.73', '0.2.73', 'ghcr.io/companionintelligence/ci-hub:0.2.73'));
    expect(section).toMatchObject({ failureCount: 0, issueCount: 0 });
    expect(stripAnsi(section.lines.join('\n'))).toContain('CLI vs stack');
  });

  it('fails doctor on a proven mismatch, naming both versions and the fix', () => {
    const section = describeVersionSkewSection(snapshot('0.2.72', '0.2.73', 'ghcr.io/companionintelligence/ci-hub:0.2.73'));
    const text = stripAnsi(section.lines.join('\n'));
    expect(section.failureCount).toBe(1);
    expect(text).toContain('0.2.72');
    expect(text).toContain('0.2.73');
    expect(text).toContain('cihub self-update --to 0.2.73');
  });

  it('notes, but does not fail, a stack whose image names no release', () => {
    const section = describeVersionSkewSection(snapshot('0.2.72', null, 'ghcr.io/companionintelligence/ci-hub@sha256:14a090870a75'));
    expect(section).toMatchObject({ failureCount: 0, issueCount: 1 });
    expect(stripAnsi(section.lines.join('\n'))).toContain('Cannot be compared');
  });

  it('puts the line in the doctor box and fails the command on a mismatch', async () => {
    skewMocks.gatherSkew.mockReturnValueOnce(
      snapshot('0.2.72', '0.2.73', 'ghcr.io/companionintelligence/ci-hub:0.2.73') as unknown as ReturnType<typeof skewMocks.gatherSkew>,
    );
    await doctorHub('prod');
    expect(doctorText()).toContain('CLI vs stack');
    expect(process.exitCode).toBe(1);
  });

  it('does not fail a source checkout driving a release stack built from another commit (CI-Hub#1727)', async () => {
    // A checkout of dev beside an installed Hub, read the way a source run really reads itself: no
    // stamp, so package.json's `0.0.0-dev` and `git rev-parse HEAD`. That failed every checkout as a
    // CLI behind its stack, pulled or not.
    vi.stubEnv('CIHUB_BUILD_VERSION', '');
    vi.stubEnv('CIHUB_BUILD_REVISION', '');
    const { gatherSkew } = await vi.importActual<typeof import('../lib/cli-version-skew.js')>('../lib/cli-version-skew.js');
    const release = 'ghcr.io/companionintelligence/ci-hub:0.2.77';
    const container = `reference=${release}\nlabelVersion=0.2.77\nrevision=5d1c0a7b2e9f4c3a8b6d0e1f2a3b4c5d6e7f8a9b\n`;
    const exec = (cmd: string, args: string[]) => {
      if (cmd === 'git') return { ok: true, stdout: 'e3be894bcf2122aaaf7b08454aec59d01ced6fac\n' };
      // `docker inspect` on the container, then `docker image inspect` for its tags.
      return { ok: true, stdout: args[0] === 'inspect' ? container : release };
    };
    skewMocks.gatherSkew.mockImplementationOnce(() => gatherSkew(exec) as unknown as ReturnType<typeof skewMocks.gatherSkew>);
    await doctorHub('prod');
    const text = doctorText();
    expect(text).toContain('CLI vs stack');
    expect(text).toContain('cihub commit e3be894bc vs stack commit 5d1c0a7b2');
    expect(text).not.toContain('older than the stack');
    expect(process.exitCode).toBeUndefined();
  });
});

/**
 * The env file that does not name the image the Hub runs.
 *
 * Fifteen of seventeen fleet appliances were recreated onto a new `:dev` digest on 2026-09-21 with
 * their env files left naming an older one. Every local check on those nodes was green, and each was
 * one reboot away from reverting to the build it had been moved off. Unlike the CLI-vs-stack line
 * this is a hard failure, because it undoes itself without anyone touching the machine.
 */
describe('Image pin', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  const REPO = 'ghcr.io/companionintelligence/ci-hub';
  const rolled = `${REPO}@sha256:35de8a86274a8aa9fb22aa9c35026e7de021be4a75004b7243625c1e3438f3e6`;
  const pinned = `${REPO}@sha256:8add981ab8b6970097b9dd3b1b28519468e1087be0d15865733300c455b2835b`;
  const section = (declared: string | undefined, running: string | null, envFile = '/home/ci/.local/share/companion-hub/.env.dev') =>
    describeImagePinSection(describePinDrift(compareDeclaredToRunning(declared, running), envFile, true), envFile);

  it('fails, and names both references, when the pin and the container disagree', () => {
    const result = section(pinned, rolled);
    const text = stripAnsi(result.lines.join('\n'));
    expect(result).toMatchObject({ failureCount: 1, issueCount: 1 });
    expect(text).toContain('Image pin');
    expect(text).toContain('8add981ab8b6');
    expect(text).toContain('35de8a86274a');
    expect(text).toContain('.env.dev');
  });

  it('is quiet when the pin is in force, or when there is nothing to compare', () => {
    expect(section(rolled, rolled)).toMatchObject({ failureCount: 0, issueCount: 0 });
    expect(section(undefined, rolled)).toMatchObject({ failureCount: 0, issueCount: 0 });
    expect(section(pinned, null)).toMatchObject({ failureCount: 0, issueCount: 0 });
  });

  it('puts the line in the doctor box and fails the command', async () => {
    pinMocks.inspectImagePin.mockReturnValueOnce({
      envFile: '/home/ci/.local/share/companion-hub/.env.dev',
      fromCompose: true,
      declared: pinned,
      drift: compareDeclaredToRunning(pinned, rolled),
      report: describePinDrift(compareDeclaredToRunning(pinned, rolled), '/home/ci/.local/share/companion-hub/.env.dev', true),
    } as unknown as ReturnType<typeof pinMocks.inspectImagePin>);
    await doctorHub('prod');
    expect(doctorText()).toContain('Image pin');
    expect(process.exitCode).toBe(1);
  });
});

/**
 * Which Hub doctor checks.
 *
 * Inside a checkout the file checks read the checkout, while the live checks reach whatever runs as
 * `ci-hub`. On a machine that also has the desktop Hub installed, that is the installed Hub, and the
 * report mixed the two without saying so (CI-Hub#1697).
 */
describe('doctor target', () => {
  const doctorText = () => (log.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  const checkout = '/home/ci/src/CI-Hub';
  const installed = '/home/ci/.local/share/companion-hub';
  /** `docker ps` answers with this; every other docker call keeps the suite default. */
  const dockerPs = (answer: { ok: boolean; stdout: string }) =>
    mocks.runCapture.mockImplementation((...args: unknown[]) =>
      (args[1] as string[])[0] === 'ps' ? answer : { stdout: 'Docker Compose version v2.0.0', ok: true },
    );

  describe('describeCheckoutTarget', () => {
    it('names the checkout when no Hub is running', () => {
      const target = describeCheckoutTarget(checkout, null);
      const text = stripAnsi(target.lines.join('\n'));
      expect(target.title).toBe('Targeting checkout');
      expect(target.tone).toBe('cyan');
      expect(text).toContain(checkout);
      expect(text).not.toContain('another folder');
    });

    it('does not warn when the running Hub was started from this checkout', () => {
      const target = describeCheckoutTarget(checkout, { workingDir: `${checkout}/`, workingDirIsCheckout: true });
      expect(target.tone).toBe('cyan');
      expect(stripAnsi(target.lines.join('\n'))).not.toContain('another folder');
    });

    it('does not warn about a running Hub whose folder compose did not record', () => {
      const target = describeCheckoutTarget(checkout, { workingDir: null, workingDirIsCheckout: false });
      expect(target.tone).toBe('cyan');
      expect(stripAnsi(target.lines.join('\n'))).not.toContain('another folder');
    });

    it('warns that the live checks reach an installed Hub, and says to run doctor outside the checkout', () => {
      const target = describeCheckoutTarget(checkout, { workingDir: installed, workingDirIsCheckout: false });
      const text = stripAnsi(target.lines.join('\n'));
      expect(target.tone).toBe('yellow');
      expect(text).toContain(checkout);
      expect(text).toContain(`started from another folder:\n${installed}`);
      expect(text).toContain('reach that Hub');
      expect(text).toContain('run cihub doctor from outside this checkout');
    });

    it('says to run doctor in the other checkout when that is where the running Hub came from', () => {
      const target = describeCheckoutTarget(checkout, { workingDir: '/home/ci/src/CI-Hub-other', workingDirIsCheckout: true });
      const text = stripAnsi(target.lines.join('\n'));
      expect(target.tone).toBe('yellow');
      expect(text).toContain('/home/ci/src/CI-Hub-other');
      expect(text).toContain('run cihub doctor in that checkout');
    });
  });

  describe('readRunningHubOrigin', () => {
    it('asks Docker only about a running Hub container, under either name', () => {
      dockerPs({ ok: true, stdout: '' });
      readRunningHubOrigin();
      const args = (mocks.runCapture.mock.calls as unknown[][]).map((call) => call[1] as string[]).find((argv) => argv[0] === 'ps');
      expect(args).toEqual(expect.arrayContaining(['status=running', 'name=^/ci-hub$', 'name=^/ci-os-hub$']));
    });

    it('returns nothing when Docker cannot be asked or no Hub is running', () => {
      dockerPs({ ok: false, stdout: '' });
      expect(readRunningHubOrigin()).toBeNull();
      dockerPs({ ok: true, stdout: '' });
      expect(readRunningHubOrigin()).toBeNull();
    });

    it('reads the folder compose started the Hub from', () => {
      dockerPs({ ok: true, stdout: `ci-hub\t${installed}` });
      expect(readRunningHubOrigin()).toEqual({ workingDir: installed, workingDirIsCheckout: false });
    });

    it('has no folder for a container compose did not create', () => {
      dockerPs({ ok: true, stdout: 'ci-hub\t' });
      expect(readRunningHubOrigin()).toEqual({ workingDir: null, workingDirIsCheckout: false });
    });

    it('recognises a folder that is a CI-Hub checkout', () => {
      const other = mkdtempSync(join(tmpdir(), 'cihub-doctor-checkout-'));
      try {
        mkdirSync(join(other, 'scripts'));
        writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'ci-hub' }));
        dockerPs({ ok: true, stdout: `ci-hub\t${other}` });
        expect(readRunningHubOrigin()).toMatchObject({ workingDirIsCheckout: true });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('doctorHub', () => {
    afterEach(() => {
      mocks.hubContext.appliance = true;
    });

    it('prints the target before the report in a checkout, with the warning when the running Hub is elsewhere', async () => {
      Object.assign(mocks.hubContext, { appliance: false, cwd: dataDir });
      dockerPs({ ok: true, stdout: `ci-hub\t${installed}` });

      await doctorHub('prod');

      const text = doctorText();
      expect(text).toContain('Targeting checkout');
      expect(text).toMatch(/started from another folder:\s+\/home\/ci\/\.local\/share\/companion-hub\n/);
      expect(text.indexOf('Targeting checkout')).toBeLessThan(text.indexOf('Hub doctor'));
      // A warning, not a failure: the checks themselves are unchanged.
      expect(process.exitCode).toBeUndefined();
    });

    it('still names the checkout when Docker cannot say which Hub is running', async () => {
      Object.assign(mocks.hubContext, { appliance: false, cwd: dataDir });
      dockerPs({ ok: false, stdout: '' });

      await doctorHub('prod');

      const text = doctorText();
      expect(text).toContain('Targeting checkout');
      expect(text).not.toContain('another folder');
    });

    it('leaves the target box to the appliance notice outside a checkout', async () => {
      dockerPs({ ok: true, stdout: `ci-hub\t${installed}` });
      await doctorHub('prod');
      expect(doctorText()).not.toContain('Targeting checkout');
    });
  });
});
