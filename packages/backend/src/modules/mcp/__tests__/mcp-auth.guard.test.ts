import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
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

  beforeEach(async () => {
    apiKeys = mock<McpApiKeyService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpAuthGuard, { provide: LoggerService, useValue: mock<LoggerService>() }, { provide: McpApiKeyService, useValue: apiKeys }],
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
      expect(apiKeys.validate).toHaveBeenCalledWith('stored-key');
    });

    it('rejects any token the store does not recognise (the env MCP_API_KEY is not a live credential)', async () => {
      // Regression: the guard must NOT accept process.env.MCP_API_KEY directly. env-helpers always
      // derives that value, so a live env compare would be an unrevocable backdoor — the derived key is
      // only usable because bootstrap seeds it into the store, where validate() (mocked false here) governs it.
      apiKeys.validate.mockResolvedValue(false);
      await expect(guard.canActivate(mockExecutionContext('Bearer derived-env-key'))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a request with a missing Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext(undefined))).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a request with a malformed Authorization header', async () => {
      await expect(guard.canActivate(mockExecutionContext('Basic abc123'))).rejects.toThrow(UnauthorizedException);
    });
  });
});
