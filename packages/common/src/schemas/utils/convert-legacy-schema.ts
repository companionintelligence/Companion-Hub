import { type dynamicComposeSchema, dynamicComposeUnion, MIN_SCHEMA_VERSION } from '../dynamic-compose.js';
import type { z } from 'zod';
import { composeV1ToLatest } from './converters/v1.js';

type ParsedCompose = z.infer<typeof dynamicComposeSchema> & { _schemaVersion: number };

export const parseComposeJson = (data: unknown): ParsedCompose => {
  const parsed = dynamicComposeUnion.safeParse(data);

  if (!parsed.success) {
    throw new Error(`Invalid dynamic compose schema: ${parsed.error.message}`);
  }

  // Determine schema version (V1 has undefined, V2 has 2)
  const schemaVersion = 'schemaVersion' in parsed.data && typeof parsed.data.schemaVersion === 'number' ? parsed.data.schemaVersion : 1;

  // Check if schema version is too old
  if (schemaVersion < MIN_SCHEMA_VERSION) {
    throw new Error('COMPOSE_ERROR_SCHEMA_TOO_OLD');
  }

  if (schemaVersion === 1) {
    const mainServiceName = Object.values(parsed.data.services).find((s) => s.isMain)?.name;
    console.warn(
      `${mainServiceName} is using deprecated schema version 1 or missing schemaVersion. Please update the compose schema to the latest version. https://docs.companionintelligence.com/reference/dynamic-compose`,
    );

    // @ts-expect-error - Type narrowing for V1 schema conversion
    const converted = composeV1ToLatest(parsed.data);
    return { ...converted, _schemaVersion: 1 } as ParsedCompose;
  }

  return { ...parsed.data, _schemaVersion: schemaVersion } as ParsedCompose;
};
