/**
 * The `Device ID` line of `cihub doctor`.
 *
 * Runs on the host, where `/etc/machine-id` is the machine's own and the env file is the one compose
 * passes to the Hub. The verdict comes from the same function the Hub uses to refuse pairing
 * (`device-id-host-check.ts`), so doctor and the Hub cannot disagree about what counts as copied.
 */
import {
  ALLOW_FOREIGN_DEVICE_ID_ENV,
  checkDeviceIdHostBinding,
  type DeviceIdHostBinding,
  type DeviceIdHostCheckInput,
} from '../../packages/backend/src/modules/registration/device-id-host-check.js';
import { parseEnvFile } from '../env-file.js';
import { BASE_COMMAND } from './cli-types.js';
import { cliFail, cliOk, colorize, dim, STEP_ICONS } from './cli-ui.js';

const LABEL = 'Device ID            ';

/**
 * A copied ID is a failure, not a note. Doctor is what an installer runs at the end of a node, and
 * this is the last point before `cihub register` binds the other Hub's device in Portal.
 */
export function describeDeviceIdBinding(binding: DeviceIdHostBinding, envFileName: string): { lines: string[]; failureCount: number } {
  switch (binding.status) {
    case 'foreign':
      return {
        lines: [
          `${LABEL}${cliFail('copied from another machine')}  ${dim(`DEVICE_ID=${binding.deviceId} in ${envFileName} is not this host's machine ID`)}`,
          `${' '.repeat(LABEL.length)}${dim(`not registered yet: set DEVICE_ID to \`cat /etc/machine-id\`, recreate the Hub, then ${BASE_COMMAND} register --code <code>`)}`,
          // A registered Hub is bound to this ID in Portal. Changing it is a re-registration, so it gets the keep option.
          `${' '.repeat(LABEL.length)}${dim(`registered under it and no other Hub has it, or moved hardware: keep it with ${ALLOW_FOREIGN_DEVICE_ID_ENV}=true`)}`,
        ],
        failureCount: 1,
      };
    case 'allowed_foreign':
      return {
        lines: [`${LABEL}${colorize(`${STEP_ICONS.pending} from another machine, kept`, 'dim')}  ${dim(`${ALLOW_FOREIGN_DEVICE_ID_ENV}=true`)}`],
        failureCount: 0,
      };
    case 'matches_host':
      return { lines: [`${LABEL}${cliOk("this machine's")}`], failureCount: 0 };
    case 'not_set':
      return {
        lines: [`${LABEL}${colorize(`${STEP_ICONS.pending} not set`, 'dim')}  ${dim('the Hub derives it from this machine')}`],
        failureCount: 0,
      };
    default:
      return { lines: [`${LABEL}${colorize(`${STEP_ICONS.pending} not checked`, 'dim')}  ${dim(binding.reason)}`], failureCount: 0 };
  }
}

export function runDeviceIdDoctorSection(
  envFileName: string,
  readFile?: DeviceIdHostCheckInput['readFile'],
): { lines: string[]; failureCount: number } {
  const vars = parseEnvFile(envFileName);
  const binding = checkDeviceIdHostBinding({ envDeviceId: vars.DEVICE_ID, allowForeign: vars[ALLOW_FOREIGN_DEVICE_ID_ENV], readFile });
  return describeDeviceIdBinding(binding, envFileName);
}
