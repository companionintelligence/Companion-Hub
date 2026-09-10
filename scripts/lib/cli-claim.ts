/**
 * `cihub claim` — give a registered Hub its first operator, without a browser.
 *
 * `cihub register` pairs the appliance and writes `ciHubApiKey` + `ciHubOrganizationId`. It does
 * NOT create the `user` row, and until now nothing headless could: the row is written by
 * `admitHubPerson` off the back of an interactive Portal login, and `POST /api/auth/register`
 * cannot finish unattended because Portal answers it with `requiresEmailVerification`. A Hub
 * installed over SSH therefore came up paired, keyed, and unable to authenticate anybody — every
 * operator call answering 401 on a valid key.
 *
 * This command is the missing step. It proves nothing new about the caller: the device key it
 * presents is host-local (`<data-dir>/state/settings.json`), so anyone who can run this could
 * already read the Hub's credentials off the disk.
 *
 * Idempotent on purpose. An installer re-running the whole flow must not fail on the one step that
 * already succeeded, so a Hub that is already claimed is reported and exits 0 — the same shape
 * `cihub register` takes when the Hub is already registered.
 */

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { HubUnreachableError } from '../public-web-cli.js';
import { requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { bold, colorize, printMessageBox } from './cli-ui.js';
import { requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { HubClaimNoDeviceKey, HubClaimRefused, isValidClaimEmail, submitHubClaim } from './hub-claim.js';

export type ClaimHubOptions = { email?: string };

/**
 * The email to claim with, or a refusal — never a prompt nobody can answer.
 *
 * Same rule `resolvePairingCode` follows, and for the same reason: `cihub fleet` drives this over
 * `ssh -n`, which has no TTY by construction, and a readline call there reads a closed stdin and
 * never settles. Exported so the refusal is testable without detaching stdin.
 */
export async function resolveClaimEmail(email: string | undefined, isTTY = process.stdin.isTTY === true): Promise<string> {
  const supplied = email?.trim() ?? '';

  if (supplied && !isValidClaimEmail(supplied)) {
    printMessageBox('Invalid email', [`"${supplied}" is not an email address.`], 'red');
    process.exit(2);
  }
  if (supplied) return supplied;

  if (!isTTY) {
    printMessageBox(
      'Email required',
      [
        'No email was given and there is no terminal to prompt on.',
        `Pass the CI Account address this Hub belongs to: ${BASE_COMMAND} claim --email you@example.com`,
      ],
      'red',
    );
    process.exit(2);
  }

  let answer = '';
  const rl = createInterface({ input, output });
  try {
    while (!isValidClaimEmail(answer)) {
      answer = (await rl.question('  Operator email: ')).trim();
      if (!isValidClaimEmail(answer)) {
        console.log(colorize('  Enter the email address of the CI Account this Hub belongs to.', 'yellow'));
      }
    }
  } finally {
    rl.close();
  }
  return answer;
}

/** What to tell the operator about a Hub that answered and said no. */
function refusalLines(refused: HubClaimRefused, env: HubEnv): string[] {
  switch (refused.code) {
    case 'AUTH_ERROR_HUB_NOT_REGISTERED':
      return [
        'This Hub is not paired with CI Portal yet, so it has no organization for an operator to belong to.',
        `Register it first: ${BASE_COMMAND} register ${env} --code <code>`,
      ];
    case 'AUTH_ERROR_HUB_CLAIM_REQUIRES_DEVICE_KEY':
      return [
        'The Hub did not accept the device key this machine presented.',
        'It may have been re-registered since the key was written; re-run register and try again.',
      ];
    default:
      return [refused.message, `Status ${refused.status}.`];
  }
}

export async function claimHub(env: HubEnv, options: ClaimHubOptions = {}) {
  const ctx = resolveHubContext(env);
  if (ctx.appliance) {
    requireRepoOrApplianceContext(`${BASE_COMMAND} claim`, 'require-seed');
  } else {
    requireRepoRoot(`${BASE_COMMAND} claim`);
  }

  const email = await resolveClaimEmail(options.email);

  try {
    const result = await submitHubClaim(ctx.envFile, email);
    printMessageBox(
      'Hub claimed',
      [
        `${bold('operator')}  ${result.username}`,
        '',
        'This Hub can now authenticate its own API with the device key.',
        'Sign in through CI Portal with the same address to get a browser session,',
        'and to admit anyone else in the organization.',
      ],
      'green',
    );
    return;
  } catch (error) {
    if (error instanceof HubClaimRefused && error.code === 'AUTH_ERROR_HUB_ALREADY_CLAIMED') {
      // Not a failure. An installer that re-runs the flow must not trip on the step that is done.
      printMessageBox('Already claimed', ['This Hub already has an operator. Nothing to do.'], 'green');
      return;
    }

    if (error instanceof HubClaimNoDeviceKey) {
      printMessageBox(
        'No device key on this machine',
        [
          'Claiming a Hub needs its device key, which only the Hub host holds.',
          '',
          ...error.checked.map((path) => `  looked in  ${path}`),
          '',
          `Run this on the Hub itself, after ${BASE_COMMAND} register ${env}.`,
        ],
        'red',
      );
      process.exit(1);
    }

    if (error instanceof HubUnreachableError) {
      printMessageBox('Hub not reachable', [error.message, `Start it first: ${BASE_COMMAND} up ${env}`], 'red');
      process.exit(1);
    }

    if (error instanceof HubClaimRefused) {
      printMessageBox('Claim refused', refusalLines(error, env), 'red');
      process.exit(1);
    }

    printMessageBox('Claim failed', [error instanceof Error ? error.message : String(error)], 'red');
    process.exit(1);
  }
}
