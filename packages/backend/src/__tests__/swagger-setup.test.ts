import { describe, expect, it } from 'vitest';
import { patchSwaggerWithZodSchemas } from '../swagger-setup';

type SwaggerDocument = Parameters<typeof patchSwaggerWithZodSchemas>[0];

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
