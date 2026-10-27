import { computeCesrDigest } from './cesr';

/** The standard 44-character placeholder for a 256-bit SHA-256 SAID in CESR encoding. */
export const SAID_PLACEHOLDER_44 = '#'.repeat(44);

/**
 * Deterministically sorts object keys recursively for canonical JSON serialization.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    sorted[k] = canonicalizeJson((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * Serializes an object canonically to a UTF-8 string.
 */
export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(canonicalizeJson(obj));
}

/**
 * Calculates and injects a Self-Addressing Identifier (SAID) into field `d`.
 * Returns a cloned object with the computed SAID in field `d`.
 */
export function computeSaid<T extends Record<string, unknown>>(data: T, saidField = 'd'): T & { [K in typeof saidField]: string } {
  const clone = { ...data, [saidField]: SAID_PLACEHOLDER_44 };
  const canonical = canonicalStringify(clone);
  const digest = computeCesrDigest(Buffer.from(canonical, 'utf8'));
  return { ...clone, [saidField]: digest };
}

/**
 * Verifies that the SAID embedded in `saidField` (default 'd') matches the canonical content digest.
 */
export function verifySaid(data: Record<string, unknown>, saidField = 'd'): boolean {
  const embeddedSaid = data[saidField];
  if (typeof embeddedSaid !== 'string' || embeddedSaid.length !== 44) {
    return false;
  }
  const testDoc = { ...data, [saidField]: SAID_PLACEHOLDER_44 };
  const canonical = canonicalStringify(testDoc);
  const computedSaid = computeCesrDigest(Buffer.from(canonical, 'utf8'));
  return embeddedSaid === computedSaid;
}
