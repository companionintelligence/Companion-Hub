import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

const CSRF_SECRET = process.env.CSRF_SECRET || process.env.API_SECRET_KEY || randomBytes(32).toString('hex');
const CSRF_TOKEN_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE_NAME = 'csrf_token';

/**
 * Generate a CSRF token
 */
export function generateCsrfToken(): string {
  const timestamp = Date.now().toString();
  const random = randomBytes(16).toString('hex');
  const payload = `${timestamp}:${random}`;
  const signature = createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

/**
 * Validate a CSRF token
 */
export function validateCsrfToken(token: string): boolean {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    
    const [timestamp, random, signature] = parts;
    const payload = `${timestamp}:${random}`;
    const expectedSignature = createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
    
    // Verify signature using timing-safe comparison
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
      return false;
    }
    
    // Check if token is not too old (24 hours max)
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > 24 * 60 * 60 * 1000) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * CSRF protection middleware
 * - Sets a CSRF cookie on GET requests
 * - Validates CSRF token on state-changing requests (POST, PUT, DELETE, PATCH)
 * - Skips validation for API key authenticated requests (service-to-service)
 * - Skips validation for OAuth token endpoint (uses client authentication)
 */
export function csrfProtection(options?: { 
  skipRoutes?: string[];
  skipMethods?: string[];
}) {
  const skipRoutes = options?.skipRoutes || ['/api/webhooks', '/oauth/token', '/oauth/introspect'];
  const skipMethods = options?.skipMethods || ['GET', 'HEAD', 'OPTIONS'];
  
  return (req: Request, res: Response, next: NextFunction) => {
    // Check if route should be skipped
    const shouldSkip = skipRoutes.some(route => req.path.startsWith(route));
    if (shouldSkip) {
      return next();
    }
    
    // Skip for safe methods
    if (skipMethods.includes(req.method)) {
      // Set CSRF cookie on GET requests if not present
      if (req.method === 'GET' && !req.cookies[CSRF_COOKIE_NAME]) {
        const token = generateCsrfToken();
        res.cookie(CSRF_COOKIE_NAME, token, {
          httpOnly: false, // Must be readable by JavaScript
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 24 * 60 * 60 * 1000, // 24 hours
        });
      }
      return next();
    }
    
    // Skip for API key authenticated requests (service-to-service)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === process.env.API_SECRET_KEY) {
      return next();
    }
    
    // Validate CSRF token for state-changing requests
    const csrfToken = req.headers[CSRF_TOKEN_HEADER.toLowerCase()] as string || req.body?._csrf;
    const csrfCookie = req.cookies[CSRF_COOKIE_NAME];
    
    if (!csrfToken || !csrfCookie) {
      return res.status(403).json({ error: 'CSRF token missing' });
    }
    
    // Token should match cookie value
    if (csrfToken !== csrfCookie) {
      return res.status(403).json({ error: 'CSRF token mismatch' });
    }
    
    // Validate token signature and expiry
    if (!validateCsrfToken(csrfToken)) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    
    next();
  };
}

/**
 * Endpoint to get a fresh CSRF token
 */
export function csrfTokenEndpoint(req: Request, res: Response) {
  const token = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ token });
}
