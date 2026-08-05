export const MCP_LAUNCH_MODES = ['container_exec', 'host_docker'] as const;
export type McpLaunchMode = (typeof MCP_LAUNCH_MODES)[number];

/** Infer how Hub should spawn a stdio MCP server from its resolved command argv. */
export function inferMcpLaunchMode(command: string[]): McpLaunchMode {
  return command[0] === 'docker' && command[1] === 'run' ? 'host_docker' : 'container_exec';
}
