import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import { parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import fs from 'node:fs';
import * as yaml from 'yaml';
import { createKvmMissingError, createRocmKfdMissingError } from './app-lifecycle-errors';

/**
 * Fails fast with friendly guidance when a compose manifest declares /dev/kfd or /dev/kvm but the
 * host cannot provide it, instead of surfacing Docker's raw device-attach error.
 *
 * Shared by install and start: a device present at install time can still be gone by a later start
 * (ROCm/KVM modules not yet loaded at boot), so start needs the same preflight rather than relying
 * only on translating Docker's error after the fact.
 */
async function isKvmDeviceAvailable(): Promise<boolean> {
  try {
    await fs.promises.access('/dev/kvm', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
function hostDevicePath(device: string): string | null {
  const hostDevice = device.split(':')[0]?.trim();
  return hostDevice || null;
}

function isKfdHostDevice(device: string): boolean {
  return hostDevicePath(device) === '/dev/kfd';
}

function isKvmHostDevice(device: string): boolean {
  return hostDevicePath(device) === '/dev/kvm';
}

/**
 * Returns which special host devices a raw user docker-compose.yml override
 * declares. Failures to parse are silently ignored so a malformed override
 * never blocks an otherwise-valid install/start.
 */
function userComposeRequiredDevices(composeYaml: string): { requiresKfd: boolean; requiresKvm: boolean } {
  try {
    const parsed = yaml.parse(composeYaml) as { services?: Record<string, { devices?: unknown[] } | null> } | null;
    if (!parsed?.services) return { requiresKfd: false, requiresKvm: false };
    let requiresKfd = false;
    let requiresKvm = false;
    for (const svc of Object.values(parsed.services)) {
      for (const device of svc?.devices ?? []) {
        if (typeof device !== 'string') continue;
        if (isKfdHostDevice(device)) requiresKfd = true;
        if (isKvmHostDevice(device)) requiresKvm = true;
      }
    }
    return { requiresKfd, requiresKvm };
  } catch {
    return { requiresKfd: false, requiresKvm: false };
  }
}

/**
 * Fail fast with friendly guidance when a compose manifest declares /dev/kfd or /dev/kvm but
 * the host can't provide it, instead of surfacing Docker's raw device-attach error. Shared by
 * install and start: a device present at install time can still be gone by a later start (e.g.
 * ROCm/KVM modules not yet loaded at boot), so start needs this same preflight rather than
 * relying solely on translating Docker's error message after the fact.
 */
export async function assertHostDevicesAvailable(moduleRef: ModuleRef, appUrn: AppUrn): Promise<void> {
  const config = moduleRef.get(ConfigurationService, { strict: false });
  const appFilesManager = moduleRef.get(AppFilesManager, { strict: false });

  // Check the base installed compose (docker-compose.json) with architecture overrides applied.
  let requiresKfd = false;
  let requiresKvm = false;
  const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
  if (composeJson.content) {
    const { services, overrides } = parseComposeJson(composeJson.content);
    const architecture = config.get('architecture');
    const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);
    for (const service of mergedServices) {
      for (const device of service.devices ?? []) {
        if (typeof device !== 'string') continue;
        if (isKfdHostDevice(device)) requiresKfd = true;
        if (isKvmHostDevice(device)) requiresKvm = true;
      }
    }
  }

  // Also check the user compose override (user-config/{store}/{app}/docker-compose.yml).
  // composeApp layers this file on top of the generated docker-compose.yml via an additional
  // -f flag. Docker Compose appends list fields across -f files, so an override that adds
  // /dev/kfd or /dev/kvm will be present in the effective compose even when the base does not.
  if (!requiresKfd || !requiresKvm) {
    const userCompose = await appFilesManager.getUserComposeFile(appUrn);
    if (userCompose.content) {
      const fromUser = userComposeRequiredDevices(userCompose.content);
      requiresKfd = requiresKfd || fromUser.requiresKfd;
      requiresKvm = requiresKvm || fromUser.requiresKvm;
    }
  }

  if (requiresKfd && !(await isRocmKfdPassthroughAvailable())) {
    throw createRocmKfdMissingError();
  }

  if (requiresKvm && !(await isKvmDeviceAvailable())) {
    throw createKvmMissingError();
  }
}
