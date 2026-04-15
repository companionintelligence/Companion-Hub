import { BadRequestException, type PipeTransform, type Type } from '@nestjs/common';
import type { z } from 'zod';

export interface ZodDto<T extends z.ZodType = z.ZodType> {
  new (): z.output<T>;
  schema: T;
  parse(data: unknown, opts?: { reportOnly?: boolean }): z.output<T>;
  parseUnknown(data: unknown, opts?: { reportOnly?: boolean }): z.output<T>;
}

export function createZodDto<T extends z.ZodType>(schema: T): ZodDto<T> {
  function parse(data: unknown, opts?: { reportOnly?: boolean }): z.output<T> {
    if (opts?.reportOnly) {
      const result = schema.safeParse(data);
      return (result.success ? result.data : data) as z.output<T>;
    }
    return schema.parse(data);
  }

  // NestJS requires a class (constructor function) for metatype reflection
  const DtoClass = class {} as unknown as ZodDto<T>;
  Object.defineProperty(DtoClass, 'schema', { value: schema, writable: false });
  Object.defineProperty(DtoClass, 'parse', { value: parse, writable: false });
  Object.defineProperty(DtoClass, 'parseUnknown', { value: parse, writable: false });
  return DtoClass;
}

export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: { metatype?: Type }) {
    const metatype = metadata?.metatype as unknown as ZodDto | undefined;
    if (!metatype?.schema) {
      return value;
    }

    const result = metatype.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }

    return result.data;
  }
}
