import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { ZodValidationPipe } from '@/common/zod-dto';
import { LoadModelBody, UnloadModelBody } from '../inference.dto';

/*
 * `models/load` and `models/unload` took an inline `@Body()` type, which Nest cannot reflect: swagger
 * had no body for load, so the generated client typed it `never`, and the global pipe passed any
 * payload through. As classes, the same shape is documented and checked on the way in.
 */
describe.each([
  ['LoadModelBody', LoadModelBody],
  ['UnloadModelBody', UnloadModelBody],
])('%s', (_name, Body) => {
  const pipe = new ZodValidationPipe();
  const check = (value: unknown) => pipe.transform(value, { metatype: Body as never, type: 'body' });

  it('takes a model id alone, which a catalog id needs', () => {
    expect(check({ modelId: 'qwen3:8b' })).toEqual({ modelId: 'qwen3:8b' });
  });

  it.each(INFERENCE_BACKEND_TYPES)('takes the %s engine beside the id, for a file the catalog does not know', (backend) => {
    expect(check({ modelId: 'user.Qwen3-8B', backend })).toEqual({ modelId: 'user.Qwen3-8B', backend });
  });

  it('keeps an empty id, so the route answers "not in the catalog" as it did before the DTO', () => {
    expect(check({ modelId: '' })).toEqual({ modelId: '' });
  });

  it('drops a field it does not know', () => {
    expect(check({ modelId: 'qwen3:8b', force: true })).toEqual({ modelId: 'qwen3:8b' });
  });

  it.each([
    ['no body', undefined],
    ['no model id', {}],
    ['a model id that is not a string', { modelId: 8 }],
    ['an engine the Hub does not run', { modelId: 'qwen3:8b', backend: 'llamacpp' }],
    ['a null engine', { modelId: 'qwen3:8b', backend: null }],
  ])('refuses %s with a 400, instead of reaching the backend registry', (_label, value) => {
    expect(() => check(value)).toThrow(BadRequestException);
  });
});
