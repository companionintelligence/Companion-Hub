import path from 'node:path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppController } from '@/app.controller';
import { SSEController } from '@/core/sse/sse.controller';
import { ApiKeyAdminController } from '@/modules/api-keys/api-key-admin.controller';
import { HubManagerGuard } from '@/modules/auth/hub-manager.guard';
import { HubPoolController } from '@/modules/hub-pool/hub-pool.controller';
import { InferenceController } from '@/modules/inference/inference.controller';
import { MarketplaceController } from '@/modules/marketplace/marketplace.controller';
import { NetworkController } from '@/modules/network/network.controller';
import { RegistrationController } from '@/modules/registration/registration.controller';
import { SystemUpdateController } from '@/modules/system-update/system-update.controller';
import { FactoryResetController } from '@/modules/system/factory-reset.controller';
import { SystemController } from '@/modules/system/system.controller';
import { TailscaleController } from '@/modules/tailscale/tailscale.controller';
import { McpAdminController } from '../mcp-admin.controller';
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

// The suite mocks `fs` with an in-memory one; this test reads the real source tree.
const { readdirSync, readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

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
  // R2-HUBHOSTESCAPE-5: adding or re-enabling an app store makes a caller-chosen repo an install
  // source for the whole appliance — a larger grant than deleting one, which was already gated.
  'hub_add_app_store',
  'hub_call_app_api',
  // Bridged MCP tools are opaque to the Hub (#936) — a bridged call can mutate anything the
  // remote server can (delete branches, overwrite files), so the proxy is always gated.
  'hub_call_app_tool',
  'hub_delete_app_store',
  'hub_delete_backup',
  'hub_delete_link',
  // R2-HUBHOSTESCAPE-6: arg-dependent — destructive only for a form naming a custom domain, which on
  // the MCP path nobody confirmed. Ordinary installs and config edits stay reachable by a 'write' key.
  'hub_install_app',
  'hub_perform_update',
  'hub_reset_app',
  'hub_restart_all_apps',
  'hub_restore_app_backup',
  'hub_stop_all_apps',
  'hub_uninstall_app',
  'hub_update_all_apps',
  'hub_update_app',
  'hub_update_app_config',
  'hub_update_app_store',
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

/** Every controller that puts `HubManagerGuard` on a route, by its file under `src/`. */
const GUARDED_CONTROLLERS: Array<[file: string, controller: { name: string; prototype: object }]> = [
  ['app.controller.ts', AppController],
  ['core/sse/sse.controller.ts', SSEController],
  ['modules/api-keys/api-key-admin.controller.ts', ApiKeyAdminController],
  ['modules/hub-pool/hub-pool.controller.ts', HubPoolController],
  ['modules/inference/inference.controller.ts', InferenceController],
  ['modules/marketplace/marketplace.controller.ts', MarketplaceController],
  ['modules/mcp/mcp-admin.controller.ts', McpAdminController],
  ['modules/network/network.controller.ts', NetworkController],
  ['modules/registration/registration.controller.ts', RegistrationController],
  ['modules/system-update/system-update.controller.ts', SystemUpdateController],
  ['modules/system/factory-reset.controller.ts', FactoryResetController],
  ['modules/system/system.controller.ts', SystemController],
  ['modules/tailscale/tailscale.controller.ts', TailscaleController],
];

/**
 * Every route that carries `HubManagerGuard`, with the MCP tools that do what it does. Those tools are
 * the Hub-wide ones (`hubWide: true`): a member may not use them over MCP because they may not over
 * HTTP. `hub_get_hub_logs` only reads, but the Hub's log routes take an owner or admin all the same.
 *
 * A route with no tool maps to `[]`. A new guarded route fails the test below until it is listed here,
 * so whoever adds it decides whether an MCP tool reaches the same thing. A new tool that does what a
 * listed route does goes next to it and is marked `hubWide`.
 */
const GUARDED_ROUTE_TOOLS: Record<string, string[]> = {
  'AppController.acknowledgeWelcome': [],
  'AppController.updateUserSettings': [],
  'ApiKeyAdminController.createKey': [],
  'ApiKeyAdminController.revokeKey': [],
  'ApiKeyAdminController.updateKey': [],
  'FactoryResetController.factoryReset': [],
  'HubPoolController.approvePeer': [],
  'HubPoolController.cancelPairingPin': [],
  'HubPoolController.deletePoolPin': [],
  'HubPoolController.disablePeer': [],
  'HubPoolController.enablePeer': [],
  'HubPoolController.mintPairingPin': [],
  'HubPoolController.pairPeer': [],
  'HubPoolController.probePeerAddress': [],
  'HubPoolController.rejectPeer': [],
  'HubPoolController.removePeer': [],
  'HubPoolController.rotateIdentity': [],
  'HubPoolController.updatePoolSettings': [],
  'HubPoolController.upgradePeer': [],
  'HubPoolController.upsertPoolPin': [],
  'InferenceController.installOllama': [],
  'InferenceController.loadModel': ['hub_load_model'],
  'InferenceController.pinModel': ['hub_pin_model'],
  'InferenceController.pullModel': ['hub_pull_model'],
  'InferenceController.removeCloudProvider': [],
  'InferenceController.rescanHardware': [],
  'InferenceController.setCloudProvider': ['hub_set_cloud_provider'],
  'InferenceController.startPullModel': ['hub_pull_model'],
  'InferenceController.unloadModel': ['hub_unload_model'],
  'InferenceController.unpinModel': ['hub_unpin_model'],
  'InferenceController.updatePreferences': [],
  'InferenceController.updateRocmInstallState': [],
  'MarketplaceController.createAppStore': ['hub_add_app_store'],
  'MarketplaceController.deleteAppStore': ['hub_delete_app_store'],
  'MarketplaceController.pullAppStores': ['hub_pull_app_stores'],
  'MarketplaceController.updateAppStore': ['hub_update_app_store'],
  // The tool runner runs any tool. It asks about the signed-in person again before a Hub-wide one.
  'McpAdminController.callTool': [],
  'NetworkController.repairOrphans': [],
  'RegistrationController.reconnectTunnel': [],
  'RegistrationController.resetRegistration': [],
  'SSEController.hubLogsEvents': ['hub_get_hub_logs'],
  'SystemController.downloadHubLogs': ['hub_get_hub_logs'],
  'SystemUpdateController.performUpdate': ['hub_perform_update'],
  'SystemUpdateController.setAutoUpdates': ['hub_set_auto_updates'],
  'TailscaleController.connectWithAuthKey': [],
  'TailscaleController.disconnect': [],
  'TailscaleController.startAuth': [],
  'TailscaleController.syncExposure': [],
};

/** `Controller.method` for each route handler a controller puts `HubManagerGuard` on, its class's guards included. */
function guardedRoutes(controller: { name: string; prototype: object }): string[] {
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
  const proto = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(proto)
    .filter((method) => {
      const handler = proto[method];
      if (method === 'constructor' || typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) {
        return false;
      }
      return [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])].includes(HubManagerGuard);
    })
    .map((method) => `${controller.name}.${method}`);
}

/** Source files under `src/` (tests left out) that name `HubManagerGuard` in a `@UseGuards`. */
function filesUsingHubManagerGuard(): string[] {
  const srcRoot = path.resolve(__dirname, '../../..');

  return readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.split(path.sep).includes('__tests__'))
    .filter((file) => /@UseGuards\([^)]*\bHubManagerGuard\b/.test(readFileSync(path.join(srcRoot, file), 'utf8')))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/** Register every real tool provider. Non-registry dependencies are unused mocks — onModuleInit only
 *  calls registry.register(); the services run inside tool handlers, which nothing here invokes. */
function registerAllTools(): McpToolRegistry {
  const registry = new McpToolRegistry();
  const m = () => mock() as never;
  new AppDiscoveryTools(m(), m(), registry, m()).onModuleInit();
  new AppLifecycleTools(m(), registry).onModuleInit();
  new AppConfigTools(m(), m(), registry, m()).onModuleInit();
  new MarketplaceTools(m(), m(), registry).onModuleInit();
  new CustomAppTools(m(), registry, m()).onModuleInit();
  new BackupTools(m(), registry).onModuleInit();
  new SystemTools(m(), m(), m(), registry).onModuleInit();
  new RegistrationTools(m(), m(), registry).onModuleInit();
  new LinkTools(m(), registry).onModuleInit();
  new AppAgentTools(m(), registry, m(), m(), m(), m(), m()).onModuleInit();
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

  it('marks exactly the tools that do what a route behind HubManagerGuard does as Hub-wide', () => {
    const toolsOfGuardedRoutes = [...new Set(Object.values(GUARDED_ROUTE_TOOLS).flat())].sort();

    expect(namesWhere((tool) => tool.hubWide === true)).toEqual(toolsOfGuardedRoutes);
  });

  it('lists every route that carries HubManagerGuard, with the tools that reach it', () => {
    const guarded = GUARDED_CONTROLLERS.flatMap(([, controller]) => guardedRoutes(controller)).sort();

    expect(guarded).toEqual(Object.keys(GUARDED_ROUTE_TOOLS).sort());
  });

  it('knows every controller that puts HubManagerGuard on a route', () => {
    expect(filesUsingHubManagerGuard()).toEqual(GUARDED_CONTROLLERS.map(([file]) => file).sort());
  });

  it('never labels a destructive tool read-only', () => {
    // 'read' and 'destructive' are contradictory, and the contradiction resolves the wrong way: the
    // read gate would pass the tool through before the destructive gate ever saw the arguments.
    expect(namesWhere((tool) => tool.access === 'read' && Boolean(tool.destructive))).toEqual([]);
  });

  it('never labels an argument-dependent destructive tool as statically read', () => {
    // `isReadOnly` is the opposite-axis predicate that lets a read-only key keep the harmless half of
    // a tool whose worst case is a write (a GET through the app-API proxy). It is optional: no
    // arguments make hub_install_app a read, so its static 'write' is the correct and stricter
    // answer. What must never appear is the reverse — access 'read' plus a destructive predicate,
    // where the read gate would pass the call through before the destructive gate saw the arguments.
    for (const tool of tools.filter((candidate) => typeof candidate.isDestructive === 'function')) {
      expect(tool.access, `${tool.name} can be destructive for some arguments but is labelled 'read'`).toBe('write');
    }
  });
});
