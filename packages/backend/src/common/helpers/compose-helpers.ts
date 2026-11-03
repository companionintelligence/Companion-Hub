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
