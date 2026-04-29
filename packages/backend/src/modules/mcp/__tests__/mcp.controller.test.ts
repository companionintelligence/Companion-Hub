import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpController } from '../mcp.controller';
import { McpService } from '../mcp.service';
import { McpAuthGuard } from '../mcp-auth.guard';
import { LoggerService } from '@/core/logger/logger.service';

describe('McpController', () => {
  let controller: McpController;
  let mcpService: MockProxy<McpService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: McpService, useValue: mock<McpService>() },
        { provide: McpAuthGuard, useValue: mock<McpAuthGuard>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = module.get<McpController>(McpController);
    mcpService = module.get(McpService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /api/mcp/sse', () => {
    it('should set Content-Type to text/event-stream', () => {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        flushHeaders: () => {},
        write: () => {},
        on: () => {},
      } as any;
      const req = { protocol: 'http', get: () => 'localhost:5002', on: () => {} } as any;

      controller.sse(req, res);
      expect(headers['Content-Type']).toBe('text/event-stream');
    });

    it('should emit an endpoint event containing the messages URL', () => {
      let written = '';
      const res = {
        setHeader: () => {},
        flushHeaders: () => {},
        write: (data: string) => {
          written += data;
        },
        on: () => {},
      } as any;
      const req = { protocol: 'http', get: () => 'localhost:5002', on: () => {} } as any;

      controller.sse(req, res);
      expect(written).toContain('event: endpoint');
      expect(written).toContain('/api/mcp/messages');
    });

    it('should track active SSE connections', () => {
      const res = { setHeader: () => {}, flushHeaders: () => {}, write: () => {}, on: () => {} } as any;
      const req = { protocol: 'http', get: () => 'localhost', on: () => {} } as any;

      controller.sse(req, res);
      expect(controller.activeConnections).toBe(1);
    });
  });

  describe('POST /api/mcp/messages', () => {
    it('should delegate to mcpService.handleMessage', async () => {
      const body = { jsonrpc: '2.0' as const, id: 1, method: 'initialize' };
      const expected = { jsonrpc: '2.0' as const, id: 1, result: {} };
      mcpService.handleMessage.mockResolvedValue(expected);

      const result = await controller.messages(body);
      expect(mcpService.handleMessage).toHaveBeenCalledWith(body);
      expect(result).toEqual(expected);
    });
  });
});
