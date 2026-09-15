import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_BODY_LIMIT, INFERENCE_BODY_LIMIT, LARGE_BODY_PATHS, payloadTooLargeHandler } from '../body-limits';

function mockRes(): Response & { body?: unknown; code?: number } {
  const res = {} as Response & { body?: unknown; code?: number };
  res.status = vi.fn((code: number) => {
    res.code = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response['json'];
  return res;
}

// An oversized body used to end as `404 Cannot POST <path>` — the parser error skipped the
// router and landed on the not-found handler. OpenClaw read that as "model not found".
describe('payloadTooLargeHandler', () => {
  it('answers a body-parser refusal with a 413 naming the limit that applied', () => {
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    payloadTooLargeHandler({ type: 'entity.too.large', status: 413 }, { path: '/api/inference/pool/api/chat' } as Request, res, next);

    expect(res.code).toBe(413);
    expect(res.body).toEqual({
      statusCode: 413,
      message: `Request body exceeds the ${INFERENCE_BODY_LIMIT} limit for /api/inference/pool/api/chat`,
      path: '/api/inference/pool/api/chat',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('names the default limit for paths outside the inference/MCP prefixes', () => {
    const res = mockRes();

    payloadTooLargeHandler({ type: 'entity.too.large' }, { path: '/api/settings' } as Request, res, vi.fn() as unknown as NextFunction);

    expect(res.body).toMatchObject({ statusCode: 413, message: expect.stringContaining(DEFAULT_BODY_LIMIT) });
  });

  it('passes every other error along untouched', () => {
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error('boom');

    payloadTooLargeHandler(err, { path: '/api/x' } as Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('covers the routes an inference-shaped body can reach', () => {
    expect(LARGE_BODY_PATHS).toEqual(['/api/inference', '/api/mcp']);
  });
});
