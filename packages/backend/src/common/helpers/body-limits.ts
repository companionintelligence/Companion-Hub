import type { NextFunction, Request, Response } from 'express';

/**
 * Request-body limits, and why there are two.
 *
 * Nest's default parser is `express.json` at 100 KB, and an oversized body does not come back as
 * a 413: the parser's error skips the router and the request ends as `404 Cannot POST <path>`,
 * which reads as a missing route. An inference request carries a whole conversation, every tool
 * schema the agent has, and sometimes base64 images — OpenClaw's first chat turn was 162 KB, so
 * every chat it sent was "route not found" while a 200-byte curl to the same path worked
 * (beta-max, 2026-09-15). MCP tool calls have the same shape.
 *
 * The generous limit is scoped to those paths; everything else keeps the default.
 */
export const DEFAULT_BODY_LIMIT = '100kb';
export const INFERENCE_BODY_LIMIT = '64mb';
/** Express mount paths (matched as prefixes, after the `/api` global prefix) that take the large limit. */
export const LARGE_BODY_PATHS = ['/api/inference', '/api/mcp'] as const;

/**
 * Turn a body-parser refusal into the 413 it is, before it can fall through to the not-found
 * handler. Registered right after the parsers so it is the first error handler in the chain.
 */
export function payloadTooLargeHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const type = (err as { type?: string } | null)?.type;
  if (type !== 'entity.too.large') {
    next(err);
    return;
  }
  const limit = LARGE_BODY_PATHS.some((prefix) => req.path.startsWith(prefix)) ? INFERENCE_BODY_LIMIT : DEFAULT_BODY_LIMIT;
  res.status(413).json({
    statusCode: 413,
    message: `Request body exceeds the ${limit} limit for ${req.path}`,
    path: req.path,
  });
}
