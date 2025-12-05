import { Request, Response, NextFunction } from 'express';

const API_SECRET_KEY = process.env.API_SECRET_KEY;

/**
 * Middleware to authenticate requests from the main application
 * Uses a shared API secret key for service-to-service communication
 */
export function authenticateRequest(req: Request, res: Response, next: NextFunction) {
  // Skip authentication in development mode
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
  }

  if (!API_SECRET_KEY) {
    console.error('API_SECRET_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (token !== API_SECRET_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}
