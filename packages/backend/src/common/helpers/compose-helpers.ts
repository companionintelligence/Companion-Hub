import type { Architecture } from '@/common/constants';
import { type DynamicCompose, type ServiceInput } from '@ci-hub/common/schemas';

const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeComposeOverride(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override;
  if (!isPlainObject(override)) return override;

  const merged: Record<string, unknown> = {};
  if (isPlainObject(base)) {
    for (const [key, value] of Object.entries(base)) {
      if (!UNSAFE_MERGE_KEYS.has(key)) merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(override)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    const baseValue = isPlainObject(base) && Object.hasOwn(base, key) ? base[key] : undefined;
    merged[key] = mergeComposeOverride(baseValue, value);
  }

  return merged;
}

/**
 * Merges architecture-specific overrides with the base configuration
 * @param services The base services from configuration
 * @param overrides The architecture-specific overrides from configuration
 * @param architecture The current system architecture
 * @returns The merged services configuration
 */
export const mergeArchitectureOverrides = (
  services: ServiceInput[],
  overrides: DynamicCompose['overrides'] | undefined,
  architecture: Architecture,
): ServiceInput[] => {
  if (!overrides?.length) {
    return services;
  }

  const architectureOverrides = overrides.find((override) => override.architecture === architecture);

  if (!architectureOverrides) {
    return services;
  }

  const servicesMap = new Map<string, ServiceInput>();
  for (const service of services) {
    servicesMap.set(service.name, service);
  }

  for (const override of architectureOverrides.services) {
    if (!override.name) continue;

    const baseService = servicesMap.get(override.name);
    if (baseService) {
      servicesMap.set(override.name, mergeComposeOverride(baseService, override) as ServiceInput);
    }
  }

  return Array.from(servicesMap.values());
};

/**
 * The services of an app that are meant to run once and end, as an init or sync helper does: `restart: "no"`,
 * not the main service and no other service needs it to stay running. `service_completed_successfully` is the
 * one `depends_on` condition that waits for a service to finish, so a dependent with any other condition (or a
 * bare list, which compose reads as `service_started`) means the service is expected to keep running.
 *
 * A one-shot that a service waits on to finish still decides whether the app starts: if it exits with an error,
 * `compose up` fails and the dependent stays `Created`. So this only matters for one nothing waits on.
 */
export const oneShotServiceNames = (services: Pick<ServiceInput, 'name' | 'restart' | 'isMain' | 'dependsOn'>[]): Set<string> => {
  const neededRunning = new Set<string>();
  for (const { dependsOn } of services) {
    if (Array.isArray(dependsOn)) {
      for (const name of dependsOn) {
        neededRunning.add(name);
      }
    } else {
      for (const [name, { condition }] of Object.entries(dependsOn ?? {})) {
        if (condition !== 'service_completed_successfully') {
          neededRunning.add(name);
        }
      }
    }
  }
  return new Set(
    services.filter((service) => service.restart === 'no' && !service.isMain && !neededRunning.has(service.name)).map((service) => service.name),
  );
};
