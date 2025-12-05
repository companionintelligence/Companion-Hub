import { Request, Response, NextFunction } from 'express';

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const store: RateLimitStore = {};

// Warn about in-memory rate limiting in production
if (process.env.NODE_ENV === 'production') {
  console.warn(
    '⚠️ Warning: Using in-memory rate limiting. For multi-instance deployments, ' +
    'consider using Redis or another shared store for rate limiting.'
  );
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const key in store) {
    if (store[key].resetTime < now) {
      delete store[key];
    }
  }
}, 60000); // Clean up every minute

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
}

/**
 * Simple in-memory rate limiter
 * For production, consider using express-rate-limit with Redis
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, message = 'Too many requests, please try again later', keyGenerator } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Use IP address as key, with fallback for proxied requests
    const defaultKey = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || 'unknown';
    const key = keyGenerator ? keyGenerator(req) : defaultKey;
    const now = Date.now();

    if (!store[key] || store[key].resetTime < now) {
      store[key] = {
        count: 1,
        resetTime: now + windowMs,
      };
      return next();
    }

    store[key].count++;

    if (store[key].count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
}

// Pre-configured rate limiters
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many API requests, please try again later',
});

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute (webhooks can be bursty)
  message: 'Too many webhook requests',
});

// Strict rate limiter for authentication endpoints (login, register, password reset)
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: 'Too many authentication attempts, please try again later',
});

// Rate limiter for OAuth endpoints
export const oauthRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: 'Too many OAuth requests, please try again later',
});

// Rate limiter for database-heavy operations
export const dbRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: 'Too many database requests, please try again later',
});
