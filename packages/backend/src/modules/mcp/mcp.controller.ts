import { Controller, Delete, Get, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { isLegacyRequest } from '@modelcontextprotocol/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { LoggerService } from '@/core/logger/logger.service';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpSessionRegistry } from './mcp-session.registry';
import { McpModernHandlerService } from './mcp-modern-handler.service';
import { mcpCallContext } from './mcp-call-context';

/**
 * BUG-MCP-1: the Hub's MCP endpoint, speaking the spec's **Streamable HTTP** transport via the
 * official SDK (replacing the old, non-compliant `GET /sse` + `POST /messages` scheme that returned
 * responses in the POST body and never streamed). A single MCP endpoint handles POST (JSON-RPC in),
 * GET (server→client SSE stream) and DELETE (session teardown); sessions are tracked by the
 * `Mcp-Session-Id` header the SDK assigns at `initialize`. Session state lives in
 * {@link McpSessionRegistry}; this controller is the thin HTTP layer. Auth is a Bearer key from the
 * hashed key store carrying the `mcp` scope ({@link McpAuthGuard} — no env credential); the endpoint
 * is rate-limited ({@link ThrottlerGuard}).
 *
 * Phase 3 dual-stack: legacy sessionful 2025 clients (`initialize` + `Mcp-Session-Id`) are routed to
 * the v1 session registry; 2026-07-28 stateless clients (per-request `_meta` envelope) are served by
 * {@link McpModernHandlerService}.
 */
@Controller('mcp')
@UseGuards(ThrottlerGuard, McpAuthGuard)
export class McpController {
  constructor(
    private readonly sessions: McpSessionRegistry,
    private readonly modernHandler: McpModernHandlerService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * POST /api/mcp — every JSON-RPC message (initialize, tools/list, tools/call, …). Legacy clients
   * send `initialize` without a modern envelope and receive a session id; 2026 clients omit sessions
   * and are handled statelessly per request.
   */
  @Post()
  @HttpCode(200)
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const webRequest = await toWebRequest(req, req.body);
    if (await isLegacyRequest(webRequest, req.body)) {
      return this.handleLegacyPost(req, res);
    }

    try {
      await this.withCallerContext(req, () => this.modernHandler.handleRequest(req, res, req.body));
    } catch (error) {
      this.logger.error('MCP modern request handling failed', error);
      if (!res.headersSent) {
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
      }
    }
  }

  /** Sessionful Streamable HTTP path for 2025-era MCP clients. */
  private async handleLegacyPost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !transport) {
      this.sendJsonRpcError(res, 404, -32001, 'Session not found; send an initialize request first.');
      return;
    }
    const isNewTransport = !transport;
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        this.sendJsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header; send an initialize request first.');
        return;
      }
      try {
        transport = await this.sessions.createConnectedTransport();
      } catch (error) {
        this.logger.error('MCP session creation failed', error);
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
        return;
      }
    }

    try {
      await this.withCallerContext(req, () => transport.handleRequest(req, res, req.body));
    } catch (error) {
      this.logger.error('MCP request handling failed', error);
      if (isNewTransport) {
        transport.close().catch(() => undefined);
      }
      if (!res.headersSent) {
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
      }
      return;
    }

    if (isNewTransport) {
      if (transport.sessionId) {
        this.sessions.store(transport);
      } else {
        transport.close().catch(() => undefined);
      }
    }
  }

  /**
   * GET /api/mcp — opens the server→client SSE stream for a session (used for server-initiated
   * notifications). The Hub sends none today, but the transport requires the endpoint to exist.
   */
  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!transport) {
      this.sendJsonRpcError(res, 404, -32001, 'Session not found.');
      return;
    }
    try {
      await this.withCallerContext(req, () => transport.handleRequest(req, res));
    } catch (error) {
      this.logger.error('MCP stream handling failed', error);
      if (!res.headersSent) {
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
      }
    }
  }

  /** DELETE /api/mcp — terminate a session and close its transport. */
  @Delete()
  @HttpCode(204)
  async handleDelete(@Headers('mcp-session-id') sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      await this.sessions.remove(sessionId);
    } catch (error) {
      this.logger.warn('MCP session close failed during DELETE', error);
    }
  }

  private withCallerContext<T>(req: Request & { mcpApiKey?: ApiKeyContext }, fn: () => Promise<T>): Promise<T> {
    const caller = req.mcpApiKey;
    return caller ? mcpCallContext.run(caller, fn) : fn();
  }

  private sendJsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
    res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  }
}
