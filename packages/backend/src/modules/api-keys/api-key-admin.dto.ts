import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

/** Body for creating an operator API key. */
const createApiKeySchema = z.object({
  /** Human-readable label shown in the keys table (e.g. "Laptop CLI", "n8n"). */
  name: z.string().trim().min(1).max(100),
});

export class CreateApiKeyBody extends createZodDto(createApiKeySchema) {}
