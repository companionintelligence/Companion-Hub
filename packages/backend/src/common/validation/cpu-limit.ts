import { z } from 'zod';

const CPU_LIMIT_PATTERN = /^(?:\d+)(?:\.\d+)?$/;

export const optionalCpuLimitSchema = z
  .string()
  .trim()
  .regex(CPU_LIMIT_PATTERN, 'CPU limit must be a positive number')
  .refine((value) => Number(value) > 0, { message: 'CPU limit must be greater than 0' })
  .optional();

/**
 * The Settings page's Default app CPU limit, where an emptied field means "no default". An empty
 * string comes out as `undefined` with the key kept, which `mergeSettingsToDisk` drops from
 * settings.json. Any other value is checked as above.
 */
export const clearableCpuLimitSchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .pipe(optionalCpuLimitSchema)
  .optional();
