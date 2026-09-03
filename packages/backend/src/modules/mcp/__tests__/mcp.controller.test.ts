import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { McpController } from '../mcp.controller';
import { McpAuthGuard } from '../mcp-auth.guard';
import { McpSessionRegistry } from '../mcp-session.registry';
import { McpModernHandlerService } from '../mcp-modern-handler.service';
import { mcpCallContext } from '../mcp-call-context';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { LoggerService } from '@/core/logger/logger.service';

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  return { ...actual, isLegacyRequest: vi.fn().mockResolvedValue(true) };
});

vi.mock('@modelcontextprotocol/node', () => ({
  toWebRequest: vi.fn(
    async (req: Request, body?: unknown) =>
      new Request('http://test/api/mcp', { method: req.method ?? 'POST', body: JSON.stringify(body ?? req.body) }),
  ),
}));

import { isLegacyRequest } from '@modelcontextprotocol/server';

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
  let modernHandler: MockProxy<McpModernHandlerService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpSessionRegistry, useValue: mock<McpSessionRegistry>() },
        { provide: McpModernHandlerService, useValue: mock<McpModernHandlerService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    })
      // Guards are exercised elsewhere; here we unit-test the routing logic only.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(McpAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<McpController>(McpController);
    sessions = module.get(McpSessionRegistry);
    modernHandler = module.get(McpModernHandlerService);
    vi.mocked(isLegacyRequest).mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /api/mcp', () => {
    it('creates a session on initialize and stores the transport', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      // The SDK assigns the session id while handling initialize.
      (transport as { sessionId?: string }).sessionId = 'new-sid';
      sessions.createConnectedTransport.mockResolvedValue(transport);

      const req = { headers: {}, body: INITIALIZE_BODY } as unknown as Request;
      await controller.handlePost(req, fakeRes());

      expect(sessions.createConnectedTransport).toHaveBeenCalled();
      expect(transport.handleRequest).toHaveBeenCalledWith(req, expect.anything(), INITIALIZE_BODY);
      expect(sessions.store).toHaveBeenCalledWith(transport);
      expect(transport.close).not.toHaveBeenCalled();
    });

    it('closes the transport and returns a JSON-RPC 500 when handleRequest throws on a new session', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      transport.handleRequest.mockRejectedValue(new Error('boom'));
      transport.close.mockResolvedValue(undefined); // real SDK close() returns a Promise
      sessions.createConnectedTransport.mockResolvedValue(transport);
      const res = fakeRes();

      const req = { headers: {}, body: INITIALIZE_BODY } as unknown as Request;
      await controller.handlePost(req, res);

      // Orphaned SDK server released, no leaked session stored, error surfaced as an envelope.
      expect(transport.close).toHaveBeenCalled();
      expect(sessions.store).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('closes the transport without storing when initialize does not establish a session', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      (transport as { sessionId?: string }).sessionId = undefined;
      transport.close.mockResolvedValue(undefined); // real SDK close() returns a Promise
      sessions.createConnectedTransport.mockResolvedValue(transport);

      const req = { headers: {}, body: INITIALIZE_BODY } as unknown as Request;
      await controller.handlePost(req, fakeRes());

      expect(sessions.store).not.toHaveBeenCalled();
      expect(transport.close).toHaveBeenCalled();
    });

    it('returns a JSON-RPC 500 when transport construction itself fails', async () => {
      sessions.createConnectedTransport.mockRejectedValue(new Error('server.connect exploded'));
      const res = fakeRes();

      const req = { headers: {}, body: INITIALIZE_BODY } as unknown as Request;
      await controller.handlePost(req, res);

      // Envelope instead of Nest's generic 500; nothing stored.
      expect(res.status).toHaveBeenCalledWith(500);
      expect(sessions.store).not.toHaveBeenCalled();
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

    it('routes modern (2026) POSTs to the stateless handler', async () => {
      vi.mocked(isLegacyRequest).mockResolvedValueOnce(false);
      const req = { headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } as unknown as Request;
      const res = fakeRes();

      await controller.handlePost(req, res);

      expect(modernHandler.handleRequest).toHaveBeenCalledWith(req, res, req.body);
      expect(sessions.createConnectedTransport).not.toHaveBeenCalled();
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

    it('returns a JSON-RPC 500 (and keeps the session) when the stream open fails', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      transport.handleRequest.mockRejectedValue(new Error('stream exploded'));
      sessions.get.mockReturnValue(transport);
      const res = fakeRes();

      await controller.handleGet({ headers: { 'mcp-session-id': 'sid-1' } } as unknown as Request, res);

      expect(res.status).toHaveBeenCalledWith(500);
      // The session's transport is registry-owned; one failed stream open must not close it.
      expect(transport.close).not.toHaveBeenCalled();
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

    it('keeps the 204 contract when the transport close fails during removal', async () => {
      sessions.remove.mockRejectedValue(new Error('close failed'));
      // remove() always deregisters the session, so DELETE must not surface a 500.
      await expect(controller.handleDelete('sid-1')).resolves.toBeUndefined();
    });
  });

  /**
   * The seam the whole per-key capability feature rests on.
   *
   * McpServerFactory reads the caller from {@link mcpCallContext}, and its own tests establish that
   * context themselves — so they keep passing even if this controller stops providing it. Nothing
   * else covers the join, and losing it fails CLOSED: every key, including a 'full' one, silently
   * degrades to read-only. That is a total outage of MCP writes that no test would have reported.
   *
   * Asserted from INSIDE handleRequest, because the store is only readable within the `run` callback
   * — checking after the call would pass against a controller that never wrapped anything.
   */
  describe('caller context', () => {
    const KEY: ApiKeyContext = { id: 7, name: 'agent-key', capability: 'full' };

    it('runs the POST handler inside the authenticated key context', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      (transport as { sessionId?: string }).sessionId = 'new-sid';
      let seen: ApiKeyContext | undefined;
      transport.handleRequest.mockImplementation(async () => {
        seen = mcpCallContext.getStore();
      });
      sessions.createConnectedTransport.mockResolvedValue(transport);

      const req = { headers: {}, body: INITIALIZE_BODY, mcpApiKey: KEY } as unknown as Request;
      await controller.handlePost(req, fakeRes());

      expect(seen).toEqual(KEY);
    });

    it('runs the GET stream inside the authenticated key context', async () => {
      const transport = mock<StreamableHTTPServerTransport>();
      let seen: ApiKeyContext | undefined;
      transport.handleRequest.mockImplementation(async () => {
        seen = mcpCallContext.getStore();
      });
      sessions.get.mockReturnValue(transport);

      const req = { headers: { 'mcp-session-id': 'sid-1' }, mcpApiKey: KEY } as unknown as Request;
      await controller.handleGet(req, fakeRes());

      expect(seen).toEqual(KEY);
    });

    it('leaves the context empty rather than fabricating one when no key was authenticated', async () => {
      // The guard makes this unreachable in production; asserted because the fail-closed default
      // belongs to the registry, and a fabricated 'read' context here would be indistinguishable
      // from a real one.
      const transport = mock<StreamableHTTPServerTransport>();
      (transport as { sessionId?: string }).sessionId = 'new-sid';
      let seen: ApiKeyContext | undefined = KEY;
      transport.handleRequest.mockImplementation(async () => {
        seen = mcpCallContext.getStore();
      });
      sessions.createConnectedTransport.mockResolvedValue(transport);

      await controller.handlePost({ headers: {}, body: INITIALIZE_BODY } as unknown as Request, fakeRes());

      expect(seen).toBeUndefined();
    });
  });
});
