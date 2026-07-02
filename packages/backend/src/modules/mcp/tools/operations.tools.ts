import { Injectable, type OnModuleInit } from '@nestjs/common';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsService } from '@/modules/apps/apps.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppOperationRegistry } from '@/modules/app-lifecycle/app-operation-registry';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

/**
 * ENH-MCP-8: tools for the async lifecycle operations that hand back a `requestId`
 * (hub_install_app, hub_start_app, hub_backup_app, …). Those tools return immediately; the real
 * work runs on the queue and completion is broadcast internally over SSE — which an MCP client
 * can't subscribe to. These tools give agents a pull-based way to follow an operation: read the
 * in-flight phase from {@link AppOperationRegistry} and/or the app's durable status, and cancel.
 */
@Injectable()
export class OperationsTools implements OnModuleInit {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly operationRegistry: AppOperationRegistry,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly appsService: AppsService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'Operations',
      name: 'hub_get_operation_status',
      description:
        'Check progress of an async app operation (the lifecycle tools that return a requestId). Returns the ' +
        "in-flight command + phase if one is running for the app, plus the app's current status. Poll this after " +
        'an async tool call — MCP has no push/stream channel.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          requestId: { type: 'string', description: 'Optional requestId from the originating tool call, to match a specific operation' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.getOperationStatus(p as { appUrn: string; requestId?: string }),
    });

    this.registry.register({
      category: 'Operations',
      name: 'hub_cancel_operation',
      description: 'Request cancellation of an in-flight app lifecycle operation. Returns the cancellation outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          requestId: { type: 'string', description: 'Optional requestId to ensure only the intended operation is cancelled' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.cancelOperation(p as { appUrn: string; requestId?: string }),
    });
  }

  /**
   * Return the in-flight operation (if the app has one, and it matches the optional requestId) plus
   * the app's durable status. A missing app (e.g. after a completed uninstall) is not an error for a
   * status probe — `appStatus` is simply null.
   */
  async getOperationStatus(params: { appUrn: string; requestId?: string }): Promise<{
    inFlight: boolean;
    command?: string;
    phase?: string;
    requestId?: string;
    appStatus: string | null;
  }> {
    const appUrn = castAppUrn(params.appUrn);
    const op = this.operationRegistry.get(appUrn);
    const matches = op && (!params.requestId || op.requestId === params.requestId);

    let appStatus: string | null = null;
    try {
      const { app } = await this.appsService.getApp(appUrn);
      appStatus = app?.status ?? null;
    } catch {
      appStatus = null;
    }

    if (matches && op) {
      return { inFlight: true, command: op.command, phase: op.phase, requestId: op.requestId, appStatus };
    }
    return { inFlight: false, appStatus };
  }

  /** Cancel an in-flight operation via the same guarded path as the REST cancel endpoint. */
  async cancelOperation(params: { appUrn: string; requestId?: string }) {
    return this.appLifecycleService.cancelOperation(castAppUrn(params.appUrn), params.requestId);
  }
}
