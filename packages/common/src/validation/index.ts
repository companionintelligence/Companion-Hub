/** biome-ignore-all lint/performance/noBarrelFile: shared validation entrypoint for frontend + backend */
export {
  HIDDEN_FIELD_TYPES,
  INSTALL_FORM_META_KEYS,
  isAppFormValid,
  isOptionalFieldEmpty,
  mergeFormFieldDefaults,
  resolveFieldValue,
  validateAppFormFields,
  validateField,
  type FormFieldValidationError,
  type ValidateAppFormOptions,
} from './form-fields.js';

export {
  buildMcpInstallSchema,
  isMcpOptionalOnlyInstall,
  type McpInstallSchema,
  type McpInstallSchemaField,
} from './mcp-install-schema.js';

export { resolveMcpCommandParts, resolveMcpTemplateString } from './mcp-command-resolver.js';
export { inferMcpLaunchMode, MCP_LAUNCH_MODES, type McpLaunchMode } from './mcp-launch.js';
