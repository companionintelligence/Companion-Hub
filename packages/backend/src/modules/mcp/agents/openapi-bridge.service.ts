import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from './agent-config.service';
import type { McpToolDefinition } from '../mcp-tool-registry.service';
import { ApiProxyService } from './api-proxy.service';

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  method: string;
  path: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Record<string, unknown>;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<
    string,
    Record<string, OpenApiOperation & { operationId?: string; summary?: string; description?: string; parameters?: unknown[]; requestBody?: unknown }>
  >;
}

export interface GeneratedToolInfo {
  name: string;
  description: string;
  source: 'openapi';
  method: string;
  path: string;
}

/**
 * Parses OpenAPI specs and generates MCP tool definitions.
 * Implements AOA-1 through AOA-5.
 */
@Injectable()
export class OpenApiBridgeService {
  private specCache = new Map<string, OpenApiSpec>();

  constructor(
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
    private readonly apiProxy: ApiProxyService,
  ) {}

  /**
   * Parse the OpenAPI spec for an app and generate MCP tool definitions.
   * S-AOA-1.1: Each operation → MCP tool named <appUrn>__<operationId>
   * S-AOA-1.2: Input schema derived from operation parameters + request body
   * S-AOA-1.3: Description from operation summary/description
   * S-AOA-1.4: Generated tools appear in tools/list
   */
  async generateTools(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<McpToolDefinition[]> {
    if (!agentConfig.openapi.enabled || !agentConfig.openapi.specPath || !agentConfig.openapi.config) {
      return [];
    }

    const spec = await this.loadSpec(agentConfig.openapi.specPath);
    if (!spec?.paths) {
      return [];
    }

    this.specCache.set(appUrn, spec);

    const operations = this.extractOperations(spec);
    const filtered = this.filterOperations(operations, agentConfig.openapi.config.operations_filter);

    return filtered.map((op) => this.operationToTool(appUrn, op, agentConfig));
  }

  /**
   * Get the raw OpenAPI spec for an app.
   * S-AOA-4.1: Returns raw spec as JSON string
   * S-AOA-4.2: Returns { available: false } when no spec
   */
  async getRawSpec(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<{ spec: string; available: boolean }> {
    if (!agentConfig.openapi.enabled || !agentConfig.openapi.specPath) {
      return { spec: '', available: false };
    }

    const cached = this.specCache.get(appUrn);
    if (cached) {
      return { spec: JSON.stringify(cached), available: true };
    }

    const spec = await this.loadSpec(agentConfig.openapi.specPath);
    if (!spec) {
      return { spec: '', available: false };
    }

    return { spec: JSON.stringify(spec), available: true };
  }

  /**
   * List all generated tools for an app (for hub_list_app_tools).
   * S-AOA-5.1: Returns all tools for that app including source info
   * S-AOA-5.2: Each tool includes { name, description, source }
   */
  async listToolInfo(appUrn: AppUrn, agentConfig: ResolvedAgentConfig): Promise<GeneratedToolInfo[]> {
    if (!agentConfig.openapi.enabled || !agentConfig.openapi.specPath) {
      return [];
    }

    const spec = this.specCache.get(appUrn) ?? (await this.loadSpec(agentConfig.openapi.specPath));
    if (!spec?.paths) {
      return [];
    }

    const operations = this.extractOperations(spec);
    const filtered = this.filterOperations(operations, agentConfig.openapi.config?.operations_filter);

    return filtered.map((op) => ({
      name: this.buildToolName(appUrn, op),
      description: op.summary ?? op.description ?? `${op.method.toUpperCase()} ${op.path}`,
      source: 'openapi' as const,
      method: op.method,
      path: op.path,
    }));
  }

  private async loadSpec(specPath: string): Promise<OpenApiSpec | null> {
    try {
      const content = await this.filesystem.readTextFile(specPath);
      if (!content) return null;

      // Try JSON first, then YAML-like (simplified — real YAML would need a parser)
      try {
        return JSON.parse(content);
      } catch {
        // For YAML files, we'd need a YAML parser. For now, try JSON.
        this.logger.warn(`OpenAPI spec at ${specPath} is not valid JSON. YAML support requires a YAML parser.`);
        return null;
      }
    } catch (err) {
      this.logger.error(`Failed to load OpenAPI spec from ${specPath}:`, err);
      return null;
    }
  }

  private extractOperations(spec: OpenApiSpec): OpenApiOperation[] {
    const operations: OpenApiOperation[] = [];

    for (const [pathStr, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
          operations.push({
            ...operation,
            method,
            path: pathStr,
            operationId: operation.operationId,
            summary: operation.summary,
            description: operation.description,
          });
        }
      }
    }

    return operations;
  }

  /**
   * Filter operations by the operations_filter patterns.
   * S-AOA-3.1: Only matching operations registered
   * S-AOA-3.2: Patterns support <METHOD> <path-glob>
   * S-AOA-3.3: When absent, all operations exposed
   */
  private filterOperations(operations: OpenApiOperation[], filter?: string[]): OpenApiOperation[] {
    if (!filter || filter.length === 0) {
      return operations;
    }

    return operations.filter((op) => {
      return filter.some((pattern) => this.matchesFilter(op, pattern));
    });
  }

  private matchesFilter(op: OpenApiOperation, pattern: string): boolean {
    const [methodPattern, pathPattern] = pattern.split(/\s+/, 2);
    if (!methodPattern) return false;

    // Check method
    const methodMatch = methodPattern === '*' || methodPattern.toUpperCase() === op.method.toUpperCase();
    if (!methodMatch) return false;

    if (!pathPattern) return true;

    // Check path with glob-style matching
    return this.globMatch(op.path, pathPattern);
  }

  private globMatch(value: string, pattern: string): boolean {
    // Convert glob to regex: * matches any segment, ** matches everything
    const regexStr = pattern.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*');
    try {
      return new RegExp(`^${regexStr}$`).test(value);
    } catch {
      return false;
    }
  }

  private buildToolName(appUrn: AppUrn, op: OpenApiOperation): string {
    const prefix = appUrn.replace(':', '_');

    if (op.operationId) {
      return `${prefix}__${op.operationId}`;
    }

    // Generate name from method + path
    const pathSlug = op.path
      .replace(/^\//, '')
      .replace(/\{[^}]+\}/g, 'by_id')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '');

    return `${prefix}__${op.method}_${pathSlug}`;
  }

  private operationToTool(appUrn: AppUrn, op: OpenApiOperation, agentConfig: ResolvedAgentConfig): McpToolDefinition {
    const name = this.buildToolName(appUrn, op);
    const description = op.summary ?? op.description ?? `${op.method.toUpperCase()} ${op.path}`;
    const inputSchema = this.buildInputSchema(op);

    const method = op.method.toUpperCase();

    return {
      name,
      description,
      inputSchema,
      // Derived from the HTTP method rather than guessed from the name: a generated tool's authority is
      // whatever its operation's verb allows, which the spec states outright. Same structural approach
      // the app-API proxy takes for hub_call_app_api, applied ahead of time because each generated tool
      // is pinned to one verb.
      access: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write',
      // Only DELETE is treated as data loss. PUT/PATCH/POST mutate, which 'write' already covers;
      // calling them destructive would put ordinary app interactions behind the 'full' capability.
      destructive: method === 'DELETE',
      handler: async (params: Record<string, unknown>) => {
        return this.apiProxy.proxyOpenApiCall(appUrn, op, params, agentConfig.openapi.config?.auth);
      },
    };
  }

  /**
   * S-AOA-1.2: Derive input schema from operation parameters + request body
   */
  private buildInputSchema(op: OpenApiOperation): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    // Parameters (path, query, header)
    for (const param of op.parameters ?? []) {
      properties[param.name] = {
        ...param.schema,
        description: param.description ?? `${param.in} parameter`,
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    // Request body
    if (op.requestBody) {
      const jsonContent = op.requestBody.content?.['application/json'];
      if (jsonContent?.schema) {
        properties.body = {
          ...jsonContent.schema,
          description: 'Request body',
        };
        if (op.requestBody.required) {
          required.push('body');
        }
      }
    }

    return { type: 'object', properties, required };
  }
}
