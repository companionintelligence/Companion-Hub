import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { AppAgentTools } from '../tools/app-agent.tools';
import { AppApiProxyTools } from '../tools/app-api-proxy.tools';
import { AppConfigTools } from '../tools/app-config.tools';
import { AppDiscoveryTools } from '../tools/app-discovery.tools';
import { AppLifecycleTools } from '../tools/app-lifecycle.tools';
import { BackupTools } from '../tools/backup.tools';
import { CustomAppTools } from '../tools/custom-app.tools';
import { InferenceTools } from '../tools/inference.tools';
import { LinkTools } from '../tools/link.tools';
import { MarketplaceTools } from '../tools/marketplace.tools';
import { OperationsTools } from '../tools/operations.tools';
import { RegistrationTools } from '../tools/registration.tools';
import { SystemTools } from '../tools/system.tools';

/**
 * Regression guard over the REAL tool registrations, pinning both classification axes:
 *
 * - ISSUE-MCP-2's destructive set. If a destructive tool is added/removed, or a flag is dropped, this
 *   fails loudly. This is the coverage that would have caught hub_restore_app_backup /
 *   hub_call_app_api / hub_update_app shipping ungated (the per-tool tests mock the registry and
 *   never inspect the flag).
 * - The read/write set that decides which tools a read-only key can reach. `access` is a required
 *   field, so a new tool cannot omit it — but it CAN be labelled wrongly, and mislabelling a mutating
 *   tool 'read' is silently worse than forgetting: it hands the tool to every key on the appliance.
 *
 * A tool counts as destructive if it carries `destructive: true` OR an arg-based `isDestructive`
 * predicate (e.g. hub_call_app_api, gated only for mutating HTTP verbs).
 */
const EXPECTED_DESTRUCTIVE = [
  'hub_call_app_api',
  // Bridged MCP tools are opaque to the Hub (#936) — a bridged call can mutate anything the
  // remote server can (delete branches, overwrite files), so the proxy is always gated.
  'hub_call_app_tool',
  'hub_delete_app_store',
  'hub_delete_backup',
  'hub_delete_link',
  'hub_perform_update',
  'hub_reset_app',
  'hub_restart_all_apps',
  'hub_restore_app_backup',
  'hub_stop_all_apps',
  'hub_uninstall_app',
  'hub_update_all_apps',
  'hub_update_app',
  'hub_update_custom_app',
  'hub_update_user_config',
].sort();

/** Every tool a read-only key may call. Deliberately a list, not a count: the failure this catches is
 *  a mutating tool labelled 'read', and only naming the members can catch that. */
const EXPECTED_READ = [
  'hub_check_app_availability',
  'hub_check_for_updates',
  'hub_check_url_availability',
  'hub_cloudflare_status',
  'hub_detect_services',
  'hub_get_app',
  'hub_get_app_logs',
  'hub_get_app_openapi',
  'hub_get_app_skill',
  'hub_get_auto_updates',
  'hub_get_cloud_providers',
  'hub_get_compose_diff',
  'hub_get_config_diff',
  'hub_get_hardware_profile',
  'hub_get_hub_logs',
  'hub_get_inference_status',
  'hub_get_memory_budget',
  'hub_get_operation_status',
  'hub_get_user_config',
  'hub_list_agent_apps',
  'hub_list_app_backups',
  'hub_list_app_stores',
  'hub_list_app_tools',
  'hub_list_enabled_stores',
  'hub_list_inference_backends',
  'hub_list_installed_apps',
  'hub_list_links',
  'hub_list_models',
  'hub_probe_domain',
  'hub_registration_status',
  'hub_search_apps',
  'hub_system_load',
].sort();

/** Register every real tool provider. Non-registry dependencies are unused mocks — onModuleInit only
 *  calls registry.register(); the services run inside tool handlers, which nothing here invokes. */
function registerAllTools(): McpToolRegistry {
  const registry = new McpToolRegistry();
  const m = () => mock() as never;
  new AppDiscoveryTools(m(), m(), registry).onModuleInit();
  new AppLifecycleTools(m(), registry).onModuleInit();
  new AppConfigTools(m(), m(), registry).onModuleInit();
  new MarketplaceTools(m(), m(), registry).onModuleInit();
  new CustomAppTools(m(), registry).onModuleInit();
  new BackupTools(m(), registry).onModuleInit();
  new SystemTools(m(), m(), m(), registry).onModuleInit();
  new RegistrationTools(m(), m(), registry).onModuleInit();
  new LinkTools(m(), registry).onModuleInit();
  new AppAgentTools(m(), registry, m(), m(), m(), m()).onModuleInit();
  new AppApiProxyTools(m(), registry, m(), m()).onModuleInit();
  new OperationsTools(registry, m(), m(), m()).onModuleInit();
  new InferenceTools(m(), registry, m(), m(), m(), m(), m(), m(), m()).onModuleInit();

  return registry;
}

describe('MCP tool classification', () => {
  const registry = registerAllTools();
  const tools = registry.listTools();
  const namesWhere = (predicate: (tool: (typeof tools)[number]) => boolean) =>
    tools
      .filter(predicate)
      .map((tool) => tool.name)
      .sort();

  it('gates exactly the expected set of destructive tools across all real tool providers (ISSUE-MCP-2)', () => {
    expect(namesWhere((tool) => Boolean(tool.destructive) || typeof tool.isDestructive === 'function')).toEqual(EXPECTED_DESTRUCTIVE);
  });

  it('exposes exactly the expected set of tools to a read-only key', () => {
    expect(namesWhere((tool) => tool.access === 'read')).toEqual(EXPECTED_READ);
  });

  it('never labels a destructive tool read-only', () => {
    // 'read' and 'destructive' are contradictory, and the contradiction resolves the wrong way: the
    // read gate would pass the tool through before the destructive gate ever saw the arguments.
    expect(namesWhere((tool) => tool.access === 'read' && Boolean(tool.destructive))).toEqual([]);
  });

  it('gives an argument-dependent tool predicates on BOTH axes, so the two cannot disagree', () => {
    // A tool that can be destructive for some arguments must also be able to say when it is merely
    // reading — otherwise a read-only key loses the harmless half of it (a GET through the proxy).
    for (const tool of tools.filter((candidate) => typeof candidate.isDestructive === 'function')) {
      expect(typeof tool.isReadOnly, `${tool.name} has isDestructive but no isReadOnly`).toBe('function');
    }
  });
});
