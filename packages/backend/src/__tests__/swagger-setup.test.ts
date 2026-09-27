import { describe, expect, it } from 'vitest';
import committedSwagger from '../swagger.json';
import { OPERATION_PATH_PARAMS, OPERATION_QUERY_DTOS, OPERATION_REQUEST_BODIES, OPERATION_RESPONSE_SCHEMAS } from '../swagger-operation-patches';
import { patchSwaggerWithZodSchemas } from '../swagger-setup';

type SwaggerDocument = Parameters<typeof patchSwaggerWithZodSchemas>[0];

/** `METHOD /path` for every operation in `document` that carries `operationId`. */
function routesFor(document: SwaggerDocument, operationId: string): string[] {
  return Object.entries(document.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([, operation]) => operation?.operationId === operationId)
      .map(([method]) => `${method.toUpperCase()} ${path}`),
  );
}

/** One operation as Nest reflects `@ApiResponse({ type: Object })`: a bare object. */
function documentWith(path: string, operationId: string): SwaggerDocument {
  return {
    paths: {
      [path]: {
        get: {
          operationId,
          responses: { default: { content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
  };
}

describe('patchSwaggerWithZodSchemas', () => {
  /*
   * The DNS check was published as a bare object, so the generated client typed
   * its answer `{ [key: string]: unknown }`. #1627's forms keyed on a `reason` the
   * Hub never sent, and nothing in the contract could say so.
   */
  it('publishes the DNS check answer with the reasons the forms act on', () => {
    const document = documentWith('/api/cloudflare/check-dns-availability', 'checkDnsAvailability');

    patchSwaggerWithZodSchemas(document);

    expect(document.paths?.['/api/cloudflare/check-dns-availability']?.get?.responses?.default?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/DnsAvailabilityResponseDto',
    });
    expect(document.components?.schemas?.DnsAvailabilityResponseDto).toEqual({
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        reason: { type: 'string', enum: ['zone_unreachable', 'hostname_taken'] },
        message: { type: 'string' },
      },
      required: ['available'],
      additionalProperties: false,
    });
  });
});

/*
 * The document above names its own operation, so it proves a map entry patches
 * whatever carries that operationId, never that a real route does. The patch loop
 * skips an id that matches nothing, and ids are bare method names, so renaming
 * `checkDnsAvailability` would quietly publish the bare object again. swagger.json is
 * what Nest really emits (`check:openapi` fails CI when it drifts), so check it.
 */
describe('committed swagger.json', () => {
  const document = committedSwagger as unknown as SwaggerDocument;

  it('publishes the DNS check answer on the route the forms call', () => {
    expect(document.paths?.['/api/cloudflare/check-dns-availability']?.get?.responses?.default?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/DnsAvailabilityResponseDto',
    });
  });

  /*
   * Exactly one: ids repeat across controllers (five routes are `getStatus`), and
   * the patch lands on whichever comes first, so a second match is as quiet as none.
   */
  it.each([
    ...Object.keys(OPERATION_QUERY_DTOS),
    ...Object.keys(OPERATION_REQUEST_BODIES),
    ...Object.keys(OPERATION_PATH_PARAMS),
    ...Object.keys(OPERATION_RESPONSE_SCHEMAS),
  ])('has one route for the %s patch', (operationId) => {
    const routes = routesFor(document, operationId);
    expect(routes, routes.join(', ') || 'no route').toHaveLength(1);
  });
});
