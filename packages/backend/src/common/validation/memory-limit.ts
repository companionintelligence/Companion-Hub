import { z } from 'zod';

// Compose byte-value format: a positive integer with an optional unit, e.g. "512m", "2g", "4096M", "1gb"
const MEMORY_LIMIT_PATTERN = /^\d+[kmg]?b?$/i;

export const optionalMemoryLimitSchema = z
  .string()
  .trim()
  .regex(MEMORY_LIMIT_PATTERN, 'Memory limit must be a positive number with an optional unit (e.g. 2048M, 4g)')
  .refine((value) => Number.parseInt(value, 10) > 0, { message: 'Memory limit must be greater than 0' })
  .optional();
