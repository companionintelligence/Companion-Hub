/**
 * MCP is on unless the operator sets MCP_ENABLED=false. AppModule uses this check to choose between
 * McpModule and McpDisabledModule. The file has no imports, so a test can load it without the app.
 */
export const isMcpEnabled = (env: NodeJS.ProcessEnv): boolean => env.MCP_ENABLED !== 'false';
