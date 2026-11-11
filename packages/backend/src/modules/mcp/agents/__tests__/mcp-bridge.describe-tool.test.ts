import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { McpBridgeService } from '../mcp-bridge.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';

const URN = 'github-mcp:ci-marketplace' as AppUrn;

const LIST_ISSUES_SCHEMA = {
  type: 'object',
  properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
  required: ['owner', 'repo'],
};

describe('McpBridgeService.describeTool', () => {
  let service: McpBridgeService;

  /** A bridge that has connected to the app and holds what its server reported. */
  const connectWith = (tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) => {
    (service as unknown as { connections: Map<string, unknown> }).connections.set(URN, {
      appUrn: URN,
      connected: true,
      tools,
      config: { enabled: true, transport: 'stdio' },
      retryCount: 0,
    });
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpBridgeService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: DockerService, useValue: mock<DockerService>() },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: EnvUtils, useValue: mock<EnvUtils>() },
      ],
    }).compile();

    service = module.get(McpBridgeService);
  });

  it('is undefined while the bridge has not connected', () => {
    expect(service.describeTool(URN, 'list_issues')).toBeUndefined();
  });

  it('returns the tool with its input schema by bare name, under its prefixed name', () => {
    connectWith([{ name: 'list_issues', description: 'List issues', inputSchema: LIST_ISSUES_SCHEMA }]);

    expect(service.describeTool(URN, 'list_issues')).toEqual({
      name: 'github-mcp_ci-marketplace__list_issues',
      description: 'List issues',
      source: 'mcp',
      inputSchema: LIST_ISSUES_SCHEMA,
    });
  });

  it('accepts the prefixed name hub_list_app_tools lists', () => {
    connectWith([{ name: 'list_issues', description: 'List issues', inputSchema: LIST_ISSUES_SCHEMA }]);

    expect(service.describeTool(URN, 'github-mcp_ci-marketplace__list_issues')?.inputSchema).toEqual(LIST_ISSUES_SCHEMA);
  });

  it('gives a tool the server listed without a schema an empty object schema', () => {
    connectWith([{ name: 'ping', description: 'Ping' } as never]);

    expect(service.describeTool(URN, 'ping')?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('is undefined for a tool the server does not have', () => {
    connectWith([{ name: 'list_issues', description: 'List issues', inputSchema: LIST_ISSUES_SCHEMA }]);

    expect(service.describeTool(URN, 'delete_everything')).toBeUndefined();
  });

  it('keeps the plain list free of schemas', () => {
    connectWith([{ name: 'list_issues', description: 'List issues', inputSchema: LIST_ISSUES_SCHEMA }]);

    expect(service.listToolInfo(URN)).toEqual([{ name: 'github-mcp_ci-marketplace__list_issues', description: 'List issues', source: 'mcp' }]);
  });
});
