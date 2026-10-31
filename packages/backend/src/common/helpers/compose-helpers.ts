import type { Architecture } from '@/common/constants';
import { type DynamicCompose, type ServiceInput } from '@ci-hub/common/schemas';

const prototypeSensitiveKeys = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneComposeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneComposeValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const clone: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!prototypeSensitiveKeys.has(key)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneComposeValue(entry),
        writable: true,
      });
    }
  }
  return clone;
}

function mergeComposeValues(target: unknown, source: unknown): unknown {
  if (Array.isArray(source)) {
    return source.map(cloneComposeValue);
  }

  if (!isRecord(target) || !isRecord(source)) {
    return cloneComposeValue(source);
  }

  const merged = cloneComposeValue(target) as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (prototypeSensitiveKeys.has(key)) {
      continue;
    }

    const mergedValue = Object.hasOwn(target, key) ? mergeComposeValues(target[key], value) : cloneComposeValue(value);
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value: mergedValue,
      writable: true,
    });
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
      servicesMap.set(override.name, mergeComposeValues(baseService, override) as ServiceInput);
    }
  }

  return Array.from(servicesMap.values());
};
