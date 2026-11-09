import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DOCKERODE } from '@/modules/docker/constants';
import { securityGrantsFor } from '@/modules/apps/security-grants';
import { isRocmKfdPassthroughAvailable } from '@/modules/inference/host-rocm-availability';
import { isConfidentialRuntime, parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import fs from 'node:fs';
import * as yaml from 'yaml';
import { createKataRuntimeMissingError, createKvmMissingError, createRocmKfdMissingError } from './app-lifecycle-errors';

/**
 * Where the host's kernel lists its KVM device. The Hub's container is given no devices, so `/dev/kvm`
 * is never there to see, whatever the host has. `/sys` is the host's own and readable from an
 * unprivileged container, and the device is only registered once KVM is usable (the module loaded and
 * virtualization on in the firmware), so this needs no extra access. `/dev/kvm` still answers for a Hub
 * run directly on the host.
 */
const KVM_DEVICE_PATHS = ['/dev/kvm', '/sys/class/misc/kvm/dev'];

/**
 * Fails fast with friendly guidance when a compose manifest declares /dev/kfd or /dev/kvm (or a
 * microVM/Confidential runtime like Kata Containers) but the host cannot provide it, instead of
 * surfacing Docker's raw device-attach or runtime error.
 *
 * Shared by install and start: a device present at install time can still be gone by a later start
 * (ROCm/KVM modules not yet loaded at boot), so start needs the same preflight rather than relying
 * only on translating Docker's error after the fact.
 */
async function isKvmDeviceAvailable(): Promise<boolean> {
  for (const path of KVM_DEVICE_PATHS) {
    try {
      await fs.promises.access(path, fs.constants.R_OK);
      return true;
    } catch {
      // Not this one. Try the next.
    }
  }
  return false;
}

/** The runtimes Docker has been set up with, or null when it can't be asked and `compose up` will answer instead. */
async function dockerRuntimes(moduleRef: ModuleRef): Promise<Set<string> | null> {
  try {
    const docker = moduleRef.get<Dockerode>(DOCKERODE, { strict: false });
    const info = await docker.info();
    return new Set(Object.keys(info.Runtimes ?? {}));
  } catch {
    return null;
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
function userComposeRequiredDevices(composeYaml: string): { requiresKfd: boolean; requiresKvm: boolean; kataRuntimes: string[] } {
  const none = { requiresKfd: false, requiresKvm: false, kataRuntimes: [] };
  try {
    const parsed = yaml.parse(composeYaml) as { services?: Record<string, { devices?: unknown[]; runtime?: unknown } | null> } | null;
    if (!parsed?.services) return none;
    let requiresKfd = false;
    let requiresKvm = false;
    const kataRuntimes: string[] = [];
    for (const svc of Object.values(parsed.services)) {
      if (typeof svc?.runtime === 'string' && isConfidentialRuntime(svc.runtime)) {
        requiresKvm = true;
        kataRuntimes.push(svc.runtime);
      }
      for (const device of svc?.devices ?? []) {
        if (typeof device !== 'string') continue;
        if (isKfdHostDevice(device)) requiresKfd = true;
        if (isKvmHostDevice(device)) requiresKvm = true;
      }
    }
    return { requiresKfd, requiresKvm, kataRuntimes };
  } catch {
    return none;
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
  const kataRuntimes = new Set<string>();
  const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
  if (composeJson.content) {
    const { services, overrides } = parseInstalledComposeJson(composeJson.content, securityGrantsFor(appUrn));
    const architecture = config.get('architecture');
    const mergedServices = mergeArchitectureOverrides(services, overrides, architecture);
    for (const service of mergedServices) {
      if (service.runtime && isConfidentialRuntime(service.runtime)) {
        requiresKvm = true;
        kataRuntimes.add(service.runtime);
      }
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
  const userCompose = await appFilesManager.getUserComposeFile(appUrn);
  if (userCompose.content) {
    const fromUser = userComposeRequiredDevices(userCompose.content);
    requiresKfd = requiresKfd || fromUser.requiresKfd;
    requiresKvm = requiresKvm || fromUser.requiresKvm;
    for (const runtime of fromUser.kataRuntimes) kataRuntimes.add(runtime);
  }

  if (requiresKfd && !(await isRocmKfdPassthroughAvailable())) {
    throw createRocmKfdMissingError();
  }

  if (requiresKvm && !(await isKvmDeviceAvailable())) {
    throw createKvmMissingError();
  }

  if (kataRuntimes.size > 0) {
    const registered = await dockerRuntimes(moduleRef);
    const missing = registered && [...kataRuntimes].find((runtime) => !registered.has(runtime));
    if (missing) {
      throw createKataRuntimeMissingError(missing);
    }
  }
}
