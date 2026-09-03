import { describe, expect, it } from 'vitest';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { formatToolError, formatToolSuccess } from '../mcp-error.handler';

describe('mcp-error.handler', () => {
  describe('formatToolSuccess', () => {
    it('should wrap result in content array with JSON text', () => {
      const result = formatToolSuccess({ value: 42 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({ value: 42 });
      expect(result.isError).toBeUndefined();
    });

    it('should handle null result', () => {
      const result = formatToolSuccess(null);
      expect(result.content[0].text).toBe('null');
    });

    it('should handle string result', () => {
      const result = formatToolSuccess('hello');
      expect(result.content[0].text).toBe('"hello"');
    });
  });

  describe('formatToolError', () => {
    it('should set isError to true', () => {
      const result = formatToolError(new Error('test'));
      expect(result.isError).toBe(true);
    });

    it('should use error message for generic errors', () => {
      const result = formatToolError(new Error('something broke'));
      expect(result.content[0].text).toBe('something broke');
    });

    it('should suggest hub_search_apps for 404 with appUrn', () => {
      const error = new NotFoundException('Not found');
      const result = formatToolError(error, 'ci-store:test');
      expect(result.content[0].text).toContain('hub_search_apps');
      expect(result.content[0].text).toContain('ci-store:test');
    });

    it('should use generic not found message for 404 without appUrn', () => {
      const error = new NotFoundException('Custom message');
      const result = formatToolError(error);
      expect(result.content[0].text).toContain('Resource not found');
    });

    it('should suggest API key check for 401 errors', () => {
      const error = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
      const result = formatToolError(error);
      expect(result.content[0].text).toContain('Authentication failed');
    });

    it('should suggest API key check for 403 errors', () => {
      const error = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
      const result = formatToolError(error);
      expect(result.content[0].text).toContain('Authentication failed');
    });

    it('should handle non-Error values', () => {
      const result = formatToolError('string error');
      expect(result.content[0].text).toBe('An unexpected error occurred.');
      expect(result.isError).toBe(true);
    });

    it('should append intlParams so the agent sees the still-connected consumers', () => {
      const error = new HttpException(
        { message: 'APP_ERROR_MEMORY_PROVIDER_IN_USE', intlParams: { count: '2', apps: 'Hermes, OpenClaw' } },
        HttpStatus.CONFLICT,
      );
      const result = formatToolError(error);
      expect(result.content[0].text).toContain('APP_ERROR_MEMORY_PROVIDER_IN_USE');
      expect(result.content[0].text).toContain('Hermes, OpenClaw');
    });
  });
});
