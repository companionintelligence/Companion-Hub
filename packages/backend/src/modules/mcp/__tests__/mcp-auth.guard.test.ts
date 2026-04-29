import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { McpAuthGuard } from '../mcp-auth.guard';
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
  const originalEnv = process.env.MCP_API_KEY;

  beforeEach(async () => {
    process.env.MCP_API_KEY = 'test-secret-key';
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpAuthGuard, { provide: LoggerService, useValue: mock<LoggerService>() }],
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
    it('should allow request with valid Authorization: Bearer <apiKey>', () => {
      const ctx = mockExecutionContext('Bearer test-secret-key');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should reject request with missing Authorization header', () => {
      const ctx = mockExecutionContext(undefined);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject request with invalid API key', () => {
      const ctx = mockExecutionContext('Bearer wrong-key');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should reject request with malformed Authorization header', () => {
      const ctx = mockExecutionContext('Basic abc123');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('should read API key from MCP_API_KEY environment variable', () => {
      process.env.MCP_API_KEY = 'different-key';
      const ctx = mockExecutionContext('Bearer different-key');
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('should throw when MCP_API_KEY is not configured', () => {
      delete process.env.MCP_API_KEY;
      const ctx = mockExecutionContext('Bearer anything');
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
