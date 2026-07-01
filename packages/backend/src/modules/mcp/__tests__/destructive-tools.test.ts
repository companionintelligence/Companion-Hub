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
 * ISSUE-MCP-2 regression guard: pin the EXACT set of destructive-gated tools across the REAL tool
 * registrations. If a destructive tool is added/removed, or a flag is dropped, this fails loudly.
 * This is the coverage that would have caught hub_restore_app_backup / hub_call_app_api /
 * hub_update_app shipping ungated (the per-tool tests mock the registry and never inspect the flag).
 *
 * A tool counts as destructive if it carries `destructive: true` OR an arg-based `isDestructive`
 * predicate (e.g. hub_call_app_api, gated only for mutating HTTP verbs).
 */
const EXPECTED_DESTRUCTIVE = [
  'hub_call_app_api',
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

describe('MCP destructive-tool classification (ISSUE-MCP-2)', () => {
  it('gates exactly the expected set of destructive tools across all real tool providers', () => {
    const registry = new McpToolRegistry();
    // Every non-registry dependency is an unused mock — onModuleInit only calls registry.register(),
    // it never invokes the service dependencies (those run inside tool handlers).
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
    new InferenceTools(m(), registry, m(), m(), m(), m(), m(), m(), m(), m(), m()).onModuleInit();

    const destructive = registry
      .listTools()
      .filter((tool) => tool.destructive || typeof tool.isDestructive === 'function')
      .map((tool) => tool.name)
      .sort();

    expect(destructive).toEqual(EXPECTED_DESTRUCTIVE);
  });
});
