import { safeParseKeepingBuilderEnforcedLabels } from '../builder-enforced-labels.js';
import { type dynamicComposeSchema, dynamicComposeUnion, MIN_SCHEMA_VERSION } from '../dynamic-compose.js';
import type { z } from 'zod';
import { composeV1ToLatest } from './converters/v1.js';

type ParsedCompose = z.infer<typeof dynamicComposeSchema> & { _schemaVersion: number };

/**
 * A compose coming into the Hub: a store app being installed, or anything else held to every rule.
 * Throws on any refusal.
 */
export const parseComposeJson = (data: unknown): ParsedCompose => {
  const parsed = dynamicComposeUnion.safeParse(data);

  if (!parsed.success) {
    throw new Error(`Invalid dynamic compose schema: ${parsed.error.message}`);
  }

  return toParsedCompose(parsed.data);
};

/**
 * A compose already on the Hub, read to start, restart or update its app or to look something up in
 * it. Like {@link parseComposeJson}, except that a label refusal the compose builder enforces itself
 * doesn't stop it: those labels stay in the result and the builder leaves them out. So an app saved
 * before a label rule existed keeps working. Every other refusal throws as in `parseComposeJson`.
 */
export const parseInstalledComposeJson = (data: unknown): ParsedCompose => {
  const parsed = safeParseKeepingBuilderEnforcedLabels(dynamicComposeUnion, data);

  if (!parsed.success) {
    throw new Error(`Invalid dynamic compose schema: ${parsed.error.message}`);
  }

  return toParsedCompose(parsed.data);
};

const toParsedCompose = (data: z.output<typeof dynamicComposeUnion>): ParsedCompose => {
  // Determine schema version (V1 has undefined, V2 has 2)
  const schemaVersion = 'schemaVersion' in data && typeof data.schemaVersion === 'number' ? data.schemaVersion : 1;

  // Check if schema version is too old
  if (schemaVersion < MIN_SCHEMA_VERSION) {
    throw new Error('COMPOSE_ERROR_SCHEMA_TOO_OLD');
  }

  if (schemaVersion === 1) {
    const mainServiceName = Object.values(data.services).find((s) => s.isMain)?.name;
    console.warn(
      `${mainServiceName} is using deprecated schema version 1 or missing schemaVersion. Please update the compose schema to the latest version. https://docs.companionintelligence.com/reference/dynamic-compose`,
    );

    // @ts-expect-error - Type narrowing for V1 schema conversion
    const converted = composeV1ToLatest(data);
    return { ...converted, _schemaVersion: 1 } as ParsedCompose;
  }

  return { ...data, _schemaVersion: schemaVersion } as ParsedCompose;
};
