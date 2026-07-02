import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { McpAuthGuard } from '../mcp-auth.guard';
import { McpApiKeyService } from '../mcp-api-key.service';
import { UnauthorizedException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';

function mockExecutionContext(authHeader?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authHeader === undefined ? {} : { authorization: authHeader },
      }),
    }),
  } as any;
}

describe('McpAuthGuard', () => {
  let guard: McpAuthGuard;
  let apiKeys: MockProxy<McpApiKeyService>;
  const originalEnv = process.env.MCP_API_KEY;

  beforeEach(async () => {
    delete process.env.MCP_API_KEY; // most tests exercise the DB path; break-glass tests set it explicitly
    apiKeys = mock<McpApiKeyService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpAuthGuard, { provide: LoggerService, useValue: mock<LoggerService>() }, { provide: McpApiKeyService, useValue: apiKeys }],
    }).compile();

    guard = module.get<McpAuthGuard>(McpAuthGuard);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_API_KEY;
    } else {
      process.env.MCP_API_KEY = originalEnv;
    }
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('canActivate', () => {
    it('allows a request whose Bearer token matches a stored key', async () => {
      apiKeys.validate.mockResolvedValue(true);
      await expect(guard.canActivate(mockExecutionContext('Bearer stored-key'))).resolves.toBe(true);
      expect(apiKeys.validate).toHaveBeenCalledWith('stored-key');
    });

    it('allows via the break-glass env MCP_API_KEY when no stored key matches', async () => {
      apiKeys.validate.mockResolvedValue(false);
      process.env.MCP_API_KEY = 'break-glass';
      await expect(guard.canActivate(mockExecutionContext('Bearer break-glass'))).resolves.toBe(true);
    });

    it('rejects a token that matches neither a stored key nor the env key', async () => {
      apiKeys.validate.mockResolvedValue(false);
      process.env.MCP_API_KEY = 'break-glass';
      await expect(guard.canActivate(mockExecutionContext('Bearer nope'))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a request with a missing Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext(undefined))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a request with a malformed Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext('Basic abc123'))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when there is no stored key match and no env key configured', async () => {
      apiKeys.validate.mockResolvedValue(false);
      await expect(guard.canActivate(mockExecutionContext('Bearer anything'))).rejects.toThrow(UnauthorizedException);
    });
  });
});
