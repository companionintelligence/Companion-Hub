import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { API_KEY_CAPABILITIES, DEFAULT_API_KEY_CAPABILITY } from './api-key.capabilities';
import { OPERATOR_MINTABLE_SCOPES } from './api-key.scopes';

/** Body for creating an operator API key. */
const createApiKeySchema = z.object({
  /** Human-readable label shown in the keys table (e.g. "Laptop CLI", "n8n"). */
  name: z.string().trim().min(1).max(100),
  /**
   * What the key may do on the MCP tool surface. Defaulted rather than required, so a client that
   * predates the field still mints a key that behaves exactly as one always did.
   */
  capability: z.enum(API_KEY_CAPABILITIES).default(DEFAULT_API_KEY_CAPABILITY),
  /**
   * Which surface the key opens. Defaulted to 'mcp', which is what this route minted before the
   * field existed — so a client that predates it is unaffected, and a key's scope is never decided
   * by omission.
   */
  scope: z.enum(OPERATOR_MINTABLE_SCOPES).default('mcp'),
});

export class CreateApiKeyBody extends createZodDto(createApiKeySchema) {}

/**
 * Body for changing an existing key. Capability is the only mutable property: the name is cosmetic
 * and the secret is deliberately unchangeable (rotation is create-new → roll-out → revoke-old), so a
 * general-purpose update body would advertise edits that do not exist.
 */
const updateApiKeySchema = z.object({
  capability: z.enum(API_KEY_CAPABILITIES),
});

export class UpdateApiKeyBody extends createZodDto(updateApiKeySchema) {}
