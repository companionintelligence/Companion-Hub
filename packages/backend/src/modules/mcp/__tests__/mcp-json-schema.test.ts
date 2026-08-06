import { describe, expect, it } from 'vitest';
import { jsonSchemaAsStandard } from '../mcp-json-schema';

describe('jsonSchemaAsStandard', () => {
  it('advertises the schema verbatim and accepts any object args', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const standard = jsonSchemaAsStandard(schema);

    expect(standard['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toEqual(schema);
    expect(standard['~standard'].validate({ q: 'hello' })).toEqual({ value: { q: 'hello' } });
    expect(standard['~standard'].validate(undefined)).toEqual({ value: {} });
  });
});
