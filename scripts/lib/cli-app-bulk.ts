/**
 * `cihub app start-all|stop-all|restart-all|update-all [env]` — one command over every app.
 *
 * Asks the running Hub to do it (see `hub-bulk-apps.ts`), so it needs the Hub up and the device key
 * this machine holds. It reports that the request was ACCEPTED: the Hub works through the apps in the
 * background, and `cihub app status` or the dashboard shows them move.
 */

import { HubUnreachableError } from '../public-web-cli.js';
import { resolveEnvFromArgs } from './cli-args.js';
import { requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND } from './cli-types.js';
import { printMessageBox } from './cli-ui.js';
import { requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { HubClaimNoDeviceKey, HubClaimRefused } from './hub-claim.js';
import { BULK_APP_ACTIONS, type BulkAppAction, HubBulkRequestTimedOut, requestBulkAppAction } from './hub-bulk-apps.js';

export async function runBulkAppCommand(action: BulkAppAction, args: string[]) {
  const env = resolveEnvFromArgs(args);
  const ctx = resolveHubContext(env);
  const command = `${BASE_COMMAND} app ${action}`;

  if (ctx.appliance) {
    requireRepoOrApplianceContext(command, 'require-seed');
  } else {
    requireRepoRoot(command);
  }

  try {
    await requestBulkAppAction(ctx.envFile, action);
    printMessageBox(command, [BULK_APP_ACTIONS[action].requested, '', `Watch them move with: ${BASE_COMMAND} app status`], 'green');
  } catch (error) {
    if (error instanceof HubClaimNoDeviceKey) {
      printMessageBox(
        'No device key on this machine',
        [
          'Driving the Hub needs its device key, which only the Hub host holds.',
          '',
          ...error.checked.map((path) => `  looked in  ${path}`),
          '',
          `Run this on the Hub itself, after ${BASE_COMMAND} register ${env}.`,
        ],
        'red',
      );
    } else if (error instanceof HubUnreachableError) {
      printMessageBox('Hub not reachable', [error.message, `Start it first: ${BASE_COMMAND} up ${env}`], 'red');
    } else if (error instanceof HubBulkRequestTimedOut) {
      printMessageBox(
        'Hub did not answer in time',
        [error.message, 'It may still be working through the apps.', `Look before asking again: ${BASE_COMMAND} app status`],
        'yellow',
      );
    } else if (error instanceof HubClaimRefused) {
      printMessageBox(`${command} refused`, [error.message, `Status ${error.status}.`], 'red');
    } else {
      printMessageBox(`${command} failed`, [error instanceof Error ? error.message : String(error)], 'red');
    }

    process.exit(1);
  }
}
