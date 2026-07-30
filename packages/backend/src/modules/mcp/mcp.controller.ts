import { Controller, Delete, Get, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { LoggerService } from '@/core/logger/logger.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpSessionRegistry } from './mcp-session.registry';

/**
 * BUG-MCP-1: the Hub's MCP endpoint, speaking the spec's **Streamable HTTP** transport via the
 * official SDK (replacing the old, non-compliant `GET /sse` + `POST /messages` scheme that returned
 * responses in the POST body and never streamed). A single MCP endpoint handles POST (JSON-RPC in),
 * GET (server→client SSE stream) and DELETE (session teardown); sessions are tracked by the
 * `Mcp-Session-Id` header the SDK assigns at `initialize`. Session state lives in
 * {@link McpSessionRegistry}; this controller is the thin HTTP layer. Auth is a Bearer key from the
 * hashed key store carrying the `mcp` scope ({@link McpAuthGuard} — no env credential); the endpoint
 * is rate-limited ({@link ThrottlerGuard}).
 * Mirrors the CI-Server MCP controller for cross-repo consistency.
 */
@Controller('mcp')
@UseGuards(ThrottlerGuard, McpAuthGuard)
export class McpController {
  constructor(
    private readonly sessions: McpSessionRegistry,
    private readonly logger: LoggerService,
  ) {}

  /**
   * POST /api/mcp — every JSON-RPC message (initialize, tools/list, tools/call, …). An `initialize`
   * with no session header creates a new transport + SDK server; subsequent calls must carry the
   * `Mcp-Session-Id` header issued at initialize.
   */
  // The SDK transport writes 200 for a successful JSON-RPC response (error paths set their own status
  // via sendJsonRpcError). Declare 200 explicitly so generated OpenAPI docs don't default this POST
  // to 201 and mislead clients — @Res() means Nest applies no status itself, so this is doc-only.
  @Post()
  @HttpCode(200)
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !transport) {
      this.sendJsonRpcError(res, 404, -32001, 'Session not found; send an initialize request first.');
      return;
    }
    // A brand-new transport connects a fresh SDK server that must be released if the request fails or
    // never establishes a session — otherwise each failed initialize leaks a server + transport.
    const isNewTransport = !transport;
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        this.sendJsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header; send an initialize request first.');
        return;
      }
      try {
        transport = await this.sessions.createConnectedTransport();
      } catch (error) {
        // Transport/server construction failed before anything was written — envelope it instead of
        // leaking Nest's generic 500 (the registry releases its half-constructed pair on failure).
        this.logger.error('MCP session creation failed', error);
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
        return;
      }
    }

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error('MCP request handling failed', error);
      if (isNewTransport) {
        transport.close().catch(() => undefined);
      }
      // handleRequest may have already streamed a partial response; only send an envelope if not.
      if (!res.headersSent) {
        this.sendJsonRpcError(res, 500, -32603, 'Internal error handling MCP request.');
      }
      return;
    }

    // The SDK assigns the session id while handling `initialize`; record it once available. If a new
    // transport finished without a session id (initialize rejected), close it so its server isn't leaked.
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
      await transport.handleRequest(req, res);
    } catch (error) {
      // Mirror handlePost: log + envelope instead of leaking Nest's generic 500. The transport
      // belongs to the registry (an existing session); one failed stream open doesn't invalidate the
      // session, so it is NOT closed here.
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
      // remove() deregisters the session even when the transport's close fails, so from the client's
      // perspective the teardown succeeded — log the close failure and keep the 204.
      this.logger.warn('MCP session close failed during DELETE', error);
    }
  }

  /** Write a JSON-RPC error envelope with an HTTP status (used for transport-level rejections). */
  private sendJsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
    res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  }
}
