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

/**
 * Why a key can't use the MCP tools that change the whole Hub (`McpToolDefinition.hubWide`), as far as
 * the Hub's own records tell:
 *
 * - 'app-key': a managed app key. It acts for its app, so there is no person whose role could be asked.
 * - 'no-creator': nobody is recorded as creating it (the CLI, or a key made before v0.2.70).
 * - 'creator-role': its creator may not manage the Hub, by the Hub's records: a stored member role, revoked
 *   access, or no organization role the routes could read (no linked Portal identity, or an unpaired Hub).
 */
export const API_KEY_HUB_WIDE_BLOCKS = ['app-key', 'no-creator', 'creator-role'] as const;

export type ApiKeyHubWideBlock = (typeof API_KEY_HUB_WIDE_BLOCKS)[number];

/** The keys card's list (GET /api/api-keys). Never carries a raw key or its hash. */
const apiKeyListSchema = z.object({
  keys: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      prefix: z.string(),
      scopes: z.array(z.string()),
      capability: z.enum(API_KEY_CAPABILITIES),
      managed: z.boolean(),
      ownerAppUrn: z.string().nullable(),
      expiresAt: z.string().nullable(),
      lastUsedAt: z.string().nullable(),
      createdAt: z.string(),
      createdByUserId: z.number().nullable(),
      createdByUsername: z.string().nullable(),
      /**
       * `null` when nothing the Hub holds stops the key (its creator's role, asked on each call, still
       * decides), or when it opens no MCP tools at all.
       */
      hubWideBlocked: z.enum(API_KEY_HUB_WIDE_BLOCKS).nullable(),
    }),
  ),
});

export class ApiKeyListDto extends createZodDto(apiKeyListSchema) {}
