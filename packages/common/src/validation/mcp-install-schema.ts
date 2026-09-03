import type { AppInfo, FormField, MarketplaceMcp } from '../schemas/app-info.js';

export type McpInstallSchemaField = {
  key: string;
  label: string;
  hint?: string;
  required: boolean;
  secret: boolean;
  default?: string | number | boolean;
  source: 'form_field' | 'mcp_env';
};

export type McpInstallSchema = {
  transport: MarketplaceMcp['transport'];
  requires?: MarketplaceMcp['requires'];
  tags: string[];
  fields: McpInstallSchemaField[];
  toolCount: number;
  bridgeable: boolean;
  bridgeWarning?: string;
};

const formFieldToSchema = (field: FormField): McpInstallSchemaField => ({
  key: field.env_variable,
  label: field.label,
  hint: field.hint,
  required: field.required ?? false,
  secret: field.type === 'password',
  default: field.default,
  source: 'form_field',
});

/** Normalize MCP install config from form_fields + mcp.env (form_fields win on conflict). */
export const buildMcpInstallSchema = (info: Pick<AppInfo, 'form_fields' | 'mcp'>): McpInstallSchema | null => {
  const mcp = info.mcp;
  if (!mcp) return null;

  const byKey = new Map<string, McpInstallSchemaField>();

  for (const env of mcp.env ?? []) {
    if (!env.key) continue;
    byKey.set(env.key, {
      key: env.key,
      label: env.label ?? env.key,
      hint: env.hint,
      required: env.required ?? false,
      secret: env.secret ?? false,
      source: 'mcp_env',
    });
  }

  for (const field of info.form_fields ?? []) {
    byKey.set(field.env_variable, formFieldToSchema(field));
  }

  let bridgeWarning: string | undefined;
  let bridgeable = true;
  if (mcp.transport === 'http' && !mcp.url) {
    bridgeable = false;
    bridgeWarning = 'HTTP MCP listings require mcp.url to be bridgeable through the Hub.';
  }

  return {
    transport: mcp.transport,
    requires: mcp.requires,
    tags: mcp.tags ?? [],
    fields: [...byKey.values()],
    toolCount: mcp.manifest?.tools?.length ?? 0,
    bridgeable,
    bridgeWarning,
  };
};

/** True when every form_field is optional (typical zero-config MCP apps like n8n-mcp). */
export const isMcpOptionalOnlyInstall = (info: Pick<AppInfo, 'mcp' | 'form_fields'>): boolean =>
  Boolean(info.mcp) && (info.form_fields?.length ?? 0) > 0 && (info.form_fields ?? []).every((f) => !f.required);
