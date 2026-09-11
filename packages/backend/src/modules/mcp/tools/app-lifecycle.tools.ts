import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { mcpCallerLifecycleActor } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

/**
 * R2-HUBHOSTESCAPE-6: whether this call reaches for one of the organization's custom domains.
 *
 * `customDomain` retargets a customer-facing hostname at this app — including one a sibling Hub in
 * the organization is currently serving — and `''` is the equally consequential other direction,
 * "park it back on the platform hostname", which takes a domain off whatever app has it. Both are
 * `!== undefined`, which is also exactly how the service reads the field: absent means "said
 * nothing", anything present is an instruction.
 *
 * `customDomainTakeover` trips the gate on its own, even though `customDomainColumns` drops an
 * unaccompanied one today. What this predicate answers is which authority the CALL is reaching for,
 * and that answer must not depend on a parsing rule three modules away staying true.
 *
 * Why the gate has to live here at all: nothing else on this path checks a grant.
 * `assertSessionAction(req, appUrn, 'configure')` is in app-lifecycle.controller.ts, not in the
 * service, and `operatorMay` reads an absent operator as consent — which is exactly the MCP case, a
 * key with no person behind it. The service now gates every caller on its named actor
 * (CI-Hub#1397), so this is the second check rather than the only one: a form carrying either field
 * is still destructive, so it still takes a 'full' key or an operator confirmation.
 */
function claimsCustomDomain(params: Record<string, unknown>): boolean {
  const form = params.form as Record<string, unknown> | undefined;
  return form?.customDomain !== undefined || form?.customDomainTakeover !== undefined;
}

@Injectable()
export class AppLifecycleTools implements OnModuleInit {
  constructor(
    private readonly appLifecycleService: AppLifecycleService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_install_app',
      access: 'write',
      // R2-HUBHOSTESCAPE-6: installing is an ordinary 'write', but an install form that names a
      // custom domain is a domain takeover wearing an install's clothes. See claimsCustomDomain.
      isDestructive: claimsCustomDomain,
      description: 'Install an app from a configured app store. Returns a requestId to track progress.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          form: {
            type: 'object',
            description:
              'Optional install config: port, exposed, domain, and app-specific form fields. Naming a customDomain or ' +
              "customDomainTakeover makes the call destructive and requires a 'full'-capability key.",
          },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.installApp(p as { appUrn: string; form?: Record<string, unknown> }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_start_app',
      access: 'write',
      description: 'Start a stopped app. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.startApp(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_stop_app',
      access: 'write',
      description: 'Stop a running app gracefully. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.stopApp(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_restart_app',
      access: 'write',
      description: 'Restart a running app. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.restartApp(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_uninstall_app',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: removes the app and (by default) deletes its data volumes.
      description:
        'Uninstall an app. Optionally delete all Docker data volumes. Returns a requestId. Uninstalling the shared CI Memory provider (ci-memory:ci-marketplace) is rejected with the list of still-connected apps unless force is true.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          deleteAllData: {
            type: 'boolean',
            description:
              "Delete Docker volumes, app data AND the app's stored backups (default true). With this set, a successful uninstall leaves nothing to restore from — pass false to keep the data and its backups.",
          },
          force: {
            type: 'boolean',
            description:
              'Required to uninstall the shared CI Memory provider while other apps are still connected. Forcing disconnects every consumer and, with deleteAllData, irrecoverably deletes the shared memory store. Default false.',
          },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.uninstallApp(p as { appUrn: string; deleteAllData?: boolean; force?: boolean }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_reset_app',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: wipes all app data back to defaults.
      description:
        'Reset an app to its default state, removing all data. Returns a requestId. Resetting the shared CI Memory provider (ci-memory:ci-marketplace) is rejected with the list of still-connected apps unless force is true.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          force: {
            type: 'boolean',
            description:
              'Required to reset the shared CI Memory provider while other apps are still connected. Forcing disconnects every consumer and irrecoverably erases the shared memory store. Default false.',
          },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.resetApp(p as { appUrn: string; force?: boolean }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_update_app',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: in-place upgrade (agent can skip the pre-update backup) → possible data loss.
      description: 'Update an app to the latest version. Optionally skip backup. Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, performBackup: { type: 'boolean', description: 'Backup before updating (default true)' } },
        required: ['appUrn'],
      },
      handler: (p) => this.updateApp(p as { appUrn: string; performBackup?: boolean }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_update_app_config',
      access: 'write',
      isDestructive: claimsCustomDomain, // R2-HUBHOSTESCAPE-6: the same form, on an app that already exists.
      description: 'Update an app configuration (port, domain, env vars). Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          form: {
            type: 'object',
            description:
              "Config fields to update. Naming a customDomain or customDomainTakeover makes the call destructive and requires a 'full'-capability key.",
          },
        },
        required: ['appUrn', 'form'],
      },
      handler: (p) => this.updateAppConfig(p as { appUrn: string; form: Record<string, unknown> }),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_update_all_apps',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: bulk mutation across every installed app.
      description: 'Update all installed apps to their latest versions.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.updateAllApps(),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_start_all_apps',
      access: 'write',
      description: 'Start all installed apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.startAllApps(),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_stop_all_apps',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: bulk mutation — stops every running app at once.
      description: 'Stop all running apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.stopAllApps(),
    });
    this.registry.register({
      category: 'App Lifecycle',
      name: 'hub_restart_all_apps',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: bulk mutation — restarts every running app at once.
      description: 'Restart all running apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.restartAllApps(),
    });
  }

  /*
   * Each lifecycle call below names its actor through `mcpCallerLifecycleActor` — the calling key, or
   * the signed-in person behind an admin-runner call — and the SERVICE decides what that admits
   * (CI-Hub#1397).
   */
  async installApp(params: { appUrn: string; form?: Record<string, unknown> }) {
    const appUrn = castAppUrn(params.appUrn);
    const actor = mcpCallerLifecycleActor('install');
    const form = params.form ?? {};
    const validation = await this.appLifecycleService.validateAppConfig(appUrn, form);
    if (!validation.valid) {
      return {
        error: true,
        message: `Install config invalid: ${validation.errors.map((e) => e.label).join(', ')}`,
        errors: validation.errors,
      };
    }
    return this.appLifecycleService.installApp({ appUrn, form, actor });
  }
  async startApp(params: { appUrn: string }) {
    return this.appLifecycleService.startApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async stopApp(params: { appUrn: string }) {
    return this.appLifecycleService.stopApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async restartApp(params: { appUrn: string }) {
    return this.appLifecycleService.restartApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async uninstallApp(params: { appUrn: string; deleteAllData?: boolean; force?: boolean }) {
    return this.appLifecycleService.uninstallApp({
      appUrn: castAppUrn(params.appUrn),
      deleteAllData: params.deleteAllData ?? true,
      force: params.force ?? false,
    });
  }
  async resetApp(params: { appUrn: string; force?: boolean }) {
    return this.appLifecycleService.resetApp({ appUrn: castAppUrn(params.appUrn), force: params.force ?? false });
  }
  async updateApp(params: { appUrn: string; performBackup?: boolean }) {
    return this.appLifecycleService.updateApp({ appUrn: castAppUrn(params.appUrn), performBackup: params.performBackup ?? true });
  }
  async updateAppConfig(params: { appUrn: string; form: Record<string, unknown> }) {
    return this.appLifecycleService.updateAppConfig({
      appUrn: castAppUrn(params.appUrn),
      form: params.form,
      actor: mcpCallerLifecycleActor('configure'),
    });
  }
  async updateAllApps() {
    return this.appLifecycleService.updateAllApps(mcpCallerLifecycleActor('update'));
  }
  async startAllApps() {
    return this.appLifecycleService.startAllApps(mcpCallerLifecycleActor('start'));
  }
  async stopAllApps() {
    return this.appLifecycleService.stopAllApps(mcpCallerLifecycleActor('stop'));
  }
  async restartAllApps() {
    return this.appLifecycleService.restartAllApps(mcpCallerLifecycleActor('restart'));
  }
}
