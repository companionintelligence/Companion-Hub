import { Injectable, type OnModuleInit } from '@nestjs/common';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';
import { LoggerService } from '@/core/logger/logger.service';
import { McpV2ServerFactory } from './mcp-v2-server.factory';

/**
 * HTTP handler for MCP 2026-07-28 (stateless per-request envelope). Legacy sessionful
 * 2025 clients are routed elsewhere via {@link isLegacyRequest} in {@link McpController}.
 */
@Injectable()
export class McpModernHandlerService implements OnModuleInit {
  private nodeHandler!: NodeMcpRequestHandler;

  constructor(
    private readonly v2Factory: McpV2ServerFactory,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    const handler = createMcpHandler((ctx) => this.v2Factory.create(ctx), {
      legacy: 'reject',
      onerror: (error) => this.logger.error('MCP modern handler error', error),
    });
    this.nodeHandler = toNodeHandler(handler, {
      onerror: (error) => this.logger.error('MCP modern Node adapter error', error),
    });
  }

  handleRequest(req: Request, res: Response, parsedBody?: unknown): Promise<void> {
    return this.nodeHandler(req, res, parsedBody);
  }
}
