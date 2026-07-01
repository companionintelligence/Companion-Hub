import { Controller, Delete, Get, Headers, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpSessionRegistry } from './mcp-session.registry';

/**
 * BUG-MCP-1: the Hub's MCP endpoint, speaking the spec's **Streamable HTTP** transport via the
 * official SDK (replacing the old, non-compliant `GET /sse` + `POST /messages` scheme that returned
 * responses in the POST body and never streamed). A single MCP endpoint handles POST (JSON-RPC in),
 * GET (server→client SSE stream) and DELETE (session teardown); sessions are tracked by the
 * `Mcp-Session-Id` header the SDK assigns at `initialize`. Session state lives in
 * {@link McpSessionRegistry}; this controller is the thin HTTP layer. Auth stays the Bearer
 * `MCP_API_KEY` ({@link McpAuthGuard}); the endpoint is rate-limited ({@link ThrottlerGuard}).
 * Mirrors the CI-Server MCP controller for cross-repo consistency.
 */
@Controller('mcp')
@UseGuards(ThrottlerGuard, McpAuthGuard)
export class McpController {
  constructor(private readonly sessions: McpSessionRegistry) {}

  /**
   * POST /api/mcp — every JSON-RPC message (initialize, tools/list, tools/call, …). An `initialize`
   * with no session header creates a new transport + SDK server; subsequent calls must carry the
   * `Mcp-Session-Id` header issued at initialize.
   */
  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    let transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !transport) {
      this.sendJsonRpcError(res, 404, -32001, 'Session not found; send an initialize request first.');
      return;
    }
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        this.sendJsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header; send an initialize request first.');
        return;
      }
      transport = await this.sessions.createConnectedTransport();
    }

    await transport.handleRequest(req, res, req.body);

    // The SDK assigns the session id while handling `initialize`; record it once available.
    if (!sessionId) {
      this.sessions.store(transport);
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
    await transport.handleRequest(req, res);
  }

  /** DELETE /api/mcp — terminate a session and close its transport. */
  @Delete()
  @HttpCode(204)
  async handleDelete(@Headers('mcp-session-id') sessionId: string | undefined): Promise<void> {
    if (sessionId) {
      await this.sessions.remove(sessionId);
    }
  }

  /** Write a JSON-RPC error envelope with an HTTP status (used for transport-level rejections). */
  private sendJsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
    res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  }
}
