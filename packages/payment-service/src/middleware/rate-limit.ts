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
}

/**
 * Simple in-memory rate limiter
 * For production, consider using express-rate-limit with Redis
 */
export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, message = 'Too many requests, please try again later' } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Use IP address as key, with fallback for proxied requests
    const key = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || 'unknown';
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
