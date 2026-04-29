import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { McpAuthGuard } from '../mcp-auth.guard';

describe('McpAuthGuard', () => {
  let guard: McpAuthGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpAuthGuard],
    }).compile();

    guard = module.get<McpAuthGuard>(McpAuthGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  // S-MCP-2.1: valid Bearer token accepted
  describe('canActivate', () => {
    it.todo('should allow request with valid Authorization: Bearer <apiKey>');

    // S-MCP-2.2: invalid/missing Authorization returns 401
    it.todo('should reject request with missing Authorization header');
    it.todo('should reject request with invalid API key');
    it.todo('should reject request with malformed Authorization header');

    // S-MCP-2.3: API key from env
    it.todo('should read API key from MCP_API_KEY environment variable');
  });
});
