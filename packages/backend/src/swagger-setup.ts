import fs from 'node:fs';
import path from 'node:path';
import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { APP_DIR } from './common/constants';
import { SWAGGER_ZOD_DTOS } from './swagger-zod-registry';
import { OPERATION_PATH_PARAMS, OPERATION_QUERY_DTOS, OPERATION_REQUEST_BODIES, OPERATION_RESPONSE_SCHEMAS } from './swagger-operation-patches';

function zodSchemaToOpenApiComponent(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { target: 'openapi-3.0', unrepresentable: 'any' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function isQueryParameterRequired(fieldSchema: z.ZodType): boolean {
  return !fieldSchema.safeParse(undefined).success;
}

function zodObjectToQueryParameters(schema: z.ZodObject): Array<Record<string, unknown>> {
  return Object.entries(schema.shape).map(([name, fieldSchema]) => ({
    name,
    in: 'query',
    required: isQueryParameterRequired(fieldSchema as z.ZodType),
    schema: zodSchemaToOpenApiComponent(fieldSchema as z.ZodType),
  }));
}

type SwaggerDocument = {
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        parameters?: unknown[];
        requestBody?: unknown;
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      }
    >
  >;
  components?: { schemas?: Record<string, unknown> };
};

function findOperation(document: SwaggerDocument, operationId: string) {
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation?.operationId === operationId) {
        return { method, operation };
      }
    }
  }
  return null;
}

function patchOperationParameters(document: SwaggerDocument) {
  for (const [operationId, dto] of Object.entries(OPERATION_QUERY_DTOS)) {
    const match = findOperation(document, operationId);
    if (!match || !dto.schema || !(dto.schema instanceof z.ZodObject)) {
      continue;
    }
    const existing = ((match.operation as { parameters?: Array<{ in?: string }> }).parameters ?? []).filter((parameter) => parameter.in === 'header');
    (match.operation as { parameters?: unknown[] }).parameters = [...zodObjectToQueryParameters(dto.schema), ...existing];
  }

  for (const [operationId, { schemaName, schema }] of Object.entries(OPERATION_REQUEST_BODIES)) {
    const match = findOperation(document, operationId);
    if (!match) {
      continue;
    }
    document.components ??= {};
    document.components.schemas ??= {};
    document.components.schemas[schemaName] = zodSchemaToOpenApiComponent(schema);
    (match.operation as { requestBody?: unknown }).requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
  }

  for (const [operationId, { schemaName, schema }] of Object.entries(OPERATION_RESPONSE_SCHEMAS)) {
    const match = findOperation(document, operationId);
    if (!match) {
      continue;
    }
    document.components ??= {};
    document.components.schemas ??= {};
    document.components.schemas[schemaName] = zodSchemaToOpenApiComponent(schema);
    const operation = match.operation as {
      responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
    };
    operation.responses ??= {};
    const responseKey = operation.responses.default ? 'default' : '200';
    if (!operation.responses[responseKey]) {
      operation.responses[responseKey] = { description: '' };
    }
    const response = operation.responses[responseKey];
    response.content ??= {};
    response.content['application/json'] ??= {};
    response.content['application/json'].schema = { $ref: `#/components/schemas/${schemaName}` };
  }

  for (const [operationId, parameters] of Object.entries(OPERATION_PATH_PARAMS)) {
    const match = findOperation(document, operationId);
    if (!match) {
      continue;
    }
    // Added to what is there, not in place of it: an operation with a query DTO already has its
    // query parameters by now, and replacing the list dropped them.
    const operation = match.operation as { parameters?: Array<{ name?: string; in?: string }> };
    const existing = operation.parameters ?? [];
    const missing = (parameters as Array<{ name?: string; in?: string }>).filter(
      (parameter) => !existing.some((current) => current.name === parameter.name && current.in === parameter.in),
    );
    operation.parameters = [...missing, ...existing];
  }
}

/** Nest sees Zod DTO classes as empty objects; patch components from Zod shapes. */
export function patchSwaggerWithZodSchemas(document: SwaggerDocument) {
  document.components ??= {};
  document.components.schemas ??= {};

  for (const dto of SWAGGER_ZOD_DTOS) {
    if (!dto.name || !dto.schema) {
      continue;
    }
    document.components.schemas[dto.name] = zodSchemaToOpenApiComponent(dto.schema);
  }

  patchOperationParameters(document);
}

export function buildSwaggerDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('CI Hub API')
    .setDescription('API specs for CI Hub')
    .setVersion('1.0')
    .setOpenAPIVersion('3.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  });
  patchSwaggerWithZodSchemas(document as unknown as SwaggerDocument);
  return document;
}

export async function writeSwaggerJsonFile(document: object) {
  const swaggerPath = path.join(APP_DIR, 'packages', 'backend', 'src', 'swagger.json');
  await fs.promises.mkdir(path.dirname(swaggerPath), { recursive: true });
  await fs.promises.writeFile(swaggerPath, `${JSON.stringify(document, null, 2)}\n`);
}
