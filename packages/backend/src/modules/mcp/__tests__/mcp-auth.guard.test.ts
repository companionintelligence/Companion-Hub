import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { McpAuthGuard } from '../mcp-auth.guard';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
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
  let apiKeys: MockProxy<ApiKeyService>;

  beforeEach(async () => {
    apiKeys = mock<ApiKeyService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpAuthGuard, { provide: LoggerService, useValue: mock<LoggerService>() }, { provide: ApiKeyService, useValue: apiKeys }],
    }).compile();

    guard = module.get<McpAuthGuard>(McpAuthGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('canActivate', () => {
    it('allows a request whose Bearer token matches a stored key', async () => {
      apiKeys.validate.mockResolvedValue(true);
      await expect(guard.canActivate(mockExecutionContext('Bearer stored-key'))).resolves.toBe(true);
      expect(apiKeys.validate).toHaveBeenCalledWith('stored-key', 'mcp');
    });

    it('rejects the env MCP_API_KEY itself when the store does not contain it (no env fallback)', async () => {
      // Regression: the guard must NOT accept process.env.MCP_API_KEY directly — env-helpers always
      // derives that value, so a live env compare would be an unrevocable backdoor. Setting the env
      // var to the presented token is what makes this test able to catch a reinstated fallback.
      const saved = process.env.MCP_API_KEY;
      process.env.MCP_API_KEY = 'derived-env-key';
      try {
        apiKeys.validate.mockResolvedValue(false);
        await expect(guard.canActivate(mockExecutionContext('Bearer derived-env-key'))).rejects.toThrow(UnauthorizedException);
      } finally {
        if (saved === undefined) {
          delete process.env.MCP_API_KEY;
        } else {
          process.env.MCP_API_KEY = saved;
        }
      }
    });

    it('rejects a request with a missing Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext(undefined))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a request with a malformed Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext('Basic abc123'))).rejects.toThrow(UnauthorizedException);
    });
  });
});
