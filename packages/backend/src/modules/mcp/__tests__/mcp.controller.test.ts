import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { McpController } from '../mcp.controller';
import { McpAuthGuard } from '../mcp-auth.guard';
import { McpSessionRegistry } from '../mcp-session.registry';

// A minimal, schema-valid MCP initialize request body (what a fresh client POSTs first).
const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
};

function fakeRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  return res;
}

describe('McpController (Streamable HTTP)', () => {
  let controller: McpController;
  let sessions: MockProxy<McpSessionRegistry>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [{ provide: McpSessionRegistry, useValue: mock<McpSessionRegistry>() }],
    })
      // Guards are exercised elsewhere; here we unit-test the routing logic only.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(McpAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<McpController>(McpController);
    sessions = module.get(McpSessionRegistry);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /api/mcp', () => {
    it('creates a session on initialize and stores the transport', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      sessions.createConnectedTransport.mockResolvedValue(transport);

      const req = { headers: {}, body: INITIALIZE_BODY } as unknown as Request;
      await controller.handlePost(req, fakeRes());

      expect(sessions.createConnectedTransport).toHaveBeenCalled();
      expect(transport.handleRequest).toHaveBeenCalledWith(req, expect.anything(), INITIALIZE_BODY);
      expect(sessions.store).toHaveBeenCalledWith(transport);
    });

    it('routes a follow-up request to the existing session transport', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      sessions.get.mockReturnValue(transport);

      const req = { headers: { 'mcp-session-id': 'sid-1' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } } as unknown as Request;
      await controller.handlePost(req, fakeRes());

      expect(sessions.get).toHaveBeenCalledWith('sid-1');
      expect(transport.handleRequest).toHaveBeenCalled();
      expect(sessions.store).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown session id', async () => {
      sessions.get.mockReturnValue(undefined);
      const res = fakeRes();
      const req = { headers: { 'mcp-session-id': 'missing' }, body: {} } as unknown as Request;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(sessions.createConnectedTransport).not.toHaveBeenCalled();
    });

    it('returns 400 when no session and body is not an initialize request', async () => {
      const res = fakeRes();
      const req = { headers: {}, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } } as unknown as Request;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/mcp', () => {
    it('opens the stream for a known session', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      sessions.get.mockReturnValue(transport);
      const req = { headers: { 'mcp-session-id': 'sid-1' } } as unknown as Request;

      await controller.handleGet(req, fakeRes());
      expect(transport.handleRequest).toHaveBeenCalled();
    });

    it('returns 404 without a valid session', async () => {
      sessions.get.mockReturnValue(undefined);
      const res = fakeRes();
      await controller.handleGet({ headers: {} } as unknown as Request, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /api/mcp', () => {
    it('removes the session', async () => {
      await controller.handleDelete('sid-1');
      expect(sessions.remove).toHaveBeenCalledWith('sid-1');
    });

    it('no-ops without a session id', async () => {
      await controller.handleDelete(undefined);
      expect(sessions.remove).not.toHaveBeenCalled();
    });
  });
});
