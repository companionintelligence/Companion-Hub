/**
 * Device identity and Hub registration against Companion Portal.
 *
 * Registration is a pairing handshake, so this module owns the interactive code prompt and the
 * polling loop as well as the HTTP calls in `register-hub.ts`.
 */

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseEnvFile } from '../env-file.js';
import { getDeviceId as resolveLocalDeviceId } from '../get-device-id.js';
import { requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, CI_CLOUD_DEFAULT, type HubEnv, type RegisterHubOptions } from './cli-types.js';
import { bold, colorize, dim, printMessageBox } from './cli-ui.js';
import { requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import {
  type DeviceIdResponse,
  fetchDeviceId,
  fetchRegistrationStatus,
  fetchStateDrift,
  formatHubAccessUrl,
  isValidPairingCode,
  normalizePairingCode,
  pollRegistrationComplete,
  prepareFreshSetup,
  registrationComplete,
  type RegistrationStatusResponse,
  resolveRegisterApiBase,
  submitPairingCode,
  waitForHubApi,
} from './register-hub.js';

export async function showDeviceId(options: { fromHub?: boolean; env?: HubEnv } = {}) {
  if (options.fromHub) {
    const env = options.env ?? 'local';
    const ctx = resolveHubContext(env);
    const apiBase = resolveRegisterApiBase(ctx.envFile);
    try {
      const deviceInfo = await fetchDeviceId(apiBase);
      if (!deviceInfo.device_id) {
        printMessageBox(
          'Device ID unavailable',
          ['The running Hub could not resolve a device ID.', 'Check backend logs and ensure the appliance initialized correctly.'],
          'red',
        );
        process.exit(1);
      }
      console.log(deviceInfo.device_id);
      return;
    } catch (error) {
      printMessageBox(
        'Device ID lookup failed',
        [error instanceof Error ? error.message : String(error), `Ensure the Hub is running: ${BASE_COMMAND} up ${env}`],
        'red',
      );
      process.exit(1);
    }
  }

  try {
    console.log(await resolveLocalDeviceId());
  } catch (error) {
    printMessageBox('Device ID lookup failed', [error instanceof Error ? error.message : String(error)], 'red');
    process.exit(1);
  }
}

/**
 * The code to pair with, or a refusal — never a prompt nobody can answer.
 *
 * `cihub fleet` drives register over `ssh -n`, which has no TTY by construction: the prompt below
 * used to read a closed stdin, never settle, and let the process exit 0 having registered nothing.
 * Refusing follows `confirmDestructive` — no terminal means fail fast naming the flag that works
 * unattended — but there is no `CI_HUB_ASSUME_YES` equivalent here, because only the operator's CI
 * Account can produce a code. Exported so that refusal is reachable without detaching stdin.
 */
export async function resolvePairingCode(env: HubEnv, code: string | undefined, isTTY = process.stdin.isTTY === true): Promise<string> {
  const supplied = code ? normalizePairingCode(code) : '';
  if (code && !isValidPairingCode(supplied)) {
    printMessageBox('Invalid pairing code', [`"${code}" is not a valid 6-character code.`], 'red');
    process.exit(2);
  }
  if (isValidPairingCode(supplied)) return supplied;

  if (!isTTY) {
    printMessageBox(
      'Pairing code required',
      [
        'No pairing code was given and there is no terminal to prompt on.',
        `Generate a code in your CI Account and pass it: ${BASE_COMMAND} register ${env} --code <code>`,
      ],
      'red',
    );
    process.exit(2);
  }

  let pairingCode = '';
  const rl = createInterface({ input, output });
  try {
    while (!isValidPairingCode(pairingCode)) {
      const answer = await rl.question('  Pairing code (6 characters): ');
      pairingCode = normalizePairingCode(answer);
      if (!isValidPairingCode(pairingCode)) {
        console.log(colorize('  Enter a valid 6-character code from your CI Account.', 'yellow'));
      }
    }
  } finally {
    rl.close();
  }
  return pairingCode;
}

/**
 * Every failure here exits non-zero.
 *
 * It used to print a red box and `return`, so `cihub register` exited 0 whether it had registered a
 * Hub or failed to reach one — and an automated installer reading the exit code could not tell the
 * difference. A fleet run that "succeeded" on fourteen unreachable machines is worse than one that
 * failed on fourteen, because nobody goes looking.
 */
export async function registerHub(env: HubEnv, options: RegisterHubOptions = {}) {
  const ctx = resolveHubContext(env);
  if (ctx.appliance) {
    requireRepoOrApplianceContext('cihub register', 'require-seed');
  } else {
    requireRepoRoot('cihub register');
  }
  const envFileName = ctx.envFile;
  const fileVars = parseEnvFile(envFileName);
  const apiBase = resolveRegisterApiBase(envFileName);
  const fallbackPortal = process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT;

  printMessageBox(
    'Checking Hub',
    [`Waiting for backend at ${apiBase}\u2026`, `If this hangs, start the stack first: ${BASE_COMMAND} up ${env}`],
    'cyan',
  );
  const ready = await waitForHubApi(apiBase, 120_000);
  if (!ready) {
    printMessageBox(
      'Hub not reachable',
      [`Could not reach ${apiBase}/api/health within 2 minutes.`, `Run ${BASE_COMMAND} up ${env} and try again.`],
      'red',
    );
    process.exit(1);
  }

  let status: RegistrationStatusResponse;
  try {
    status = await fetchRegistrationStatus(apiBase);
  } catch (error) {
    printMessageBox('Registration check failed', [error instanceof Error ? error.message : String(error)], 'red');
    process.exit(1);
  }

  if (registrationComplete(status)) {
    printMessageBox('Already registered', [`Phase: ${status.phase}`, 'No pairing needed. Use cihub status to inspect tunnel and URLs.'], 'green');
    return;
  }

  let shouldPrepareFresh = options.fresh === true;
  if (!shouldPrepareFresh) {
    try {
      const drift = await fetchStateDrift(apiBase);
      shouldPrepareFresh = drift.detected;
    } catch {
      // Non-fatal ? proceed without auto-clearing drift.
    }
  }

  if (shouldPrepareFresh) {
    printMessageBox(
      'Clearing local registration state',
      [
        options.fresh
          ? 'Requested via --fresh: removing stale local registration artifacts before pairing.'
          : 'State drift detected: clearing local registration artifacts before pairing (same as "Set up as new device").',
      ],
      'cyan',
    );
    try {
      const prepared = await prepareFreshSetup(apiBase);
      if (!prepared.success) {
        printMessageBox('Prepare fresh failed', [prepared.message || 'Unknown error'], 'red');
        process.exit(1);
      }
      printMessageBox('Local state cleared', [prepared.message], 'green');
    } catch (error) {
      printMessageBox('Prepare fresh failed', [error instanceof Error ? error.message : String(error)], 'red');
      process.exit(1);
    }
  }

  let deviceInfo: DeviceIdResponse;
  try {
    deviceInfo = await fetchDeviceId(apiBase);
  } catch (error) {
    printMessageBox('Device info failed', [error instanceof Error ? error.message : String(error)], 'red');
    process.exit(1);
  }

  const deviceId = deviceInfo.device_id;
  const portalUrl = (deviceInfo.ci_cloud_url || fallbackPortal).replace(/\/$/, '');

  if (!deviceId) {
    printMessageBox(
      'Device ID unavailable',
      ['The running Hub could not resolve a device ID.', 'Check backend logs and ensure the appliance initialized correctly.'],
      'red',
    );
    process.exit(1);
  }

  printMessageBox(
    'Pair with Companion Cloud',
    [
      `${bold('device id')}  ${deviceId}`,
      `${bold('portal')}     ${colorize(portalUrl, 'cyan')}`,
      '',
      '1. Sign in at the portal URL above (or create an account).',
      '2. Generate a 6-character pairing code for this device.',
      '3. Enter the code below \u2014 no browser access to this Hub is required.',
      '',
      'The Hub will provision your Cloudflare tunnel automatically after pairing.',
    ],
    'green',
  );

  const pairingCode = await resolvePairingCode(env, options.code);

  printMessageBox('Pairing', ['Submitting pairing code to the Hub\u2026'], 'cyan');
  const pairResult = await submitPairingCode(apiBase, pairingCode);
  if (!pairResult.success) {
    printMessageBox('Pairing failed', [pairResult.message || 'Unknown error'], 'red');
    process.exit(1);
  }

  const accessHint = formatHubAccessUrl(pairResult.domain, pairResult.subdomain);
  printMessageBox(
    'Pairing accepted',
    [
      'Provisioning tunnel and DNS \u2014 this usually takes 1\u20133 minutes.',
      accessHint ? `${bold('hub url')}     ${colorize(accessHint, 'cyan')}` : '',
      '',
      'You can close this SSH session once provisioning completes.',
    ].filter(Boolean),
    'green',
  );

  const finalStatus = await pollRegistrationComplete(apiBase, 300_000, (tick) => {
    if (tick.phase === 'provisioning' || tick.phase === 'paired') {
      process.stdout.write(`${dim(`  \u2022 phase ${tick.phase}`)}\n`);
    }
  });

  if (!finalStatus || !registrationComplete(finalStatus)) {
    printMessageBox(
      'Provisioning still in progress',
      [
        'Pairing succeeded but the Hub has not reached a ready phase yet.',
        `Check progress with: ${BASE_COMMAND} status ${env}`,
        'Or open the dashboard locally while tunnel DNS propagates.',
      ],
      'yellow',
    );
    return;
  }

  const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN || pairResult.domain;
  const hubUrl = accessHint || (cfDomain ? `https://${cfDomain}` : undefined);
  printMessageBox(
    'Registration complete',
    [
      `Phase: ${finalStatus.phase}`,
      hubUrl ? `${bold('access')}      ${colorize(hubUrl, 'cyan')}` : 'Tunnel is active \u2014 see cihub status for the public URL.',
      '',
      'Port forwarding is not required. Access the Hub from the provisioned URL above.',
    ],
    'green',
  );
}

/** Force-remove every container belonging to a compose project (best-effort, never aborts). */
