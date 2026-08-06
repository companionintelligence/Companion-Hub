import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

/**
 * Wrap a raw JSON Schema object as a Standard Schema for {@link McpServer.registerTool}.
 * Validation is delegated to tool handlers; the schema is advertised verbatim in tools/list.
 */
export function jsonSchemaAsStandard(schema: Record<string, unknown>): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ci-hub',
      validate: (value: unknown) => ({ value: (value ?? {}) as Record<string, unknown> }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  };
}
