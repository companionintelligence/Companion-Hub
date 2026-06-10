import { z } from 'zod';

const CPU_LIMIT_PATTERN = /^(?:\d+)(?:\.\d+)?$/;

export const optionalCpuLimitSchema = z
  .string()
  .trim()
  .regex(CPU_LIMIT_PATTERN, 'CPU limit must be a positive number')
  .refine((value) => Number(value) > 0, { message: 'CPU limit must be greater than 0' })
  .optional();
