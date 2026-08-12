import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { McpAuthGuard } from '../mcp-auth.guard';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { LoggerService } from '@/core/logger/logger.service';

/** An execution context whose request object is stable across getRequest() calls, so a test can read
 *  back what the guard attached to it — the guard's job is not only to say yes, but to leave the
 *  authenticated key where the controller can find it. */
function mockExecutionContext(authHeader?: string) {
  const request: Record<string, unknown> = { headers: authHeader === undefined ? {} : { authorization: authHeader } };
  return {
    request,
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

const KEY = { id: 7, name: 'Laptop CLI', capability: 'write' as const };

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
      apiKeys.resolve.mockResolvedValue(KEY);
      await expect(guard.canActivate(mockExecutionContext('Bearer stored-key'))).resolves.toBe(true);
      expect(apiKeys.resolve).toHaveBeenCalledWith('stored-key', 'mcp');
    });

    it('attaches the resolved key to the request, so enforcement can consult the caller', async () => {
      // Resolved, not merely validated: what the key may DO is a property of the credential, so a
      // yes/no answer would leave the tool surface with nothing to enforce against.
      apiKeys.resolve.mockResolvedValue(KEY);
      const context = mockExecutionContext('Bearer stored-key');
      await guard.canActivate(context);
      expect(context.request.mcpApiKey).toEqual(KEY);
    });

    it('leaves no key on the request when authentication fails', async () => {
      apiKeys.resolve.mockResolvedValue(null);
      const context = mockExecutionContext('Bearer wrong-key');
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(context.request.mcpApiKey).toBeUndefined();
    });

    it('rejects the env MCP_API_KEY itself when the store does not contain it (no env fallback)', async () => {
      // Regression: the guard must NOT accept process.env.MCP_API_KEY directly — env-helpers always
      // derives that value, so a live env compare would be an unrevocable backdoor. Setting the env
      // var to the presented token is what makes this test able to catch a reinstated fallback.
      const saved = process.env.MCP_API_KEY;
      process.env.MCP_API_KEY = 'derived-env-key';
      try {
        apiKeys.resolve.mockResolvedValue(null);
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

    it('answers 503 (not 401) when the key store is unreachable (#933)', async () => {
      // A DB outage is not an auth verdict: a 401 tells a correctly-credentialed client its key
      // is bad and points operators at the wrong layer.
      apiKeys.resolve.mockRejectedValue(new ApiKeyStoreUnavailableError(new Error('getaddrinfo EAI_AGAIN ci-hub-db')));
      await expect(guard.canActivate(mockExecutionContext('Bearer stored-key'))).rejects.toThrow(ServiceUnavailableException);
    });

    it('still surfaces unexpected resolve() errors unchanged', async () => {
      const bug = new Error('unexpected');
      apiKeys.resolve.mockRejectedValue(bug);
      await expect(guard.canActivate(mockExecutionContext('Bearer stored-key'))).rejects.toBe(bug);
    });
  });
});
