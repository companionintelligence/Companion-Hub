import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase } from '../database.js';
import { OAuthService } from '../services/oauth.js';
import { AccountService } from '../services/account.js';
import { oauthRateLimit, authRateLimit } from '../middleware/rate-limit.js';

export const oauthRouter = Router();

// Validation schemas
const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(['S256', 'plain']).optional(),
});

const tokenBodySchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
});

const registerClientSchema = z.object({
  name: z.string().min(1).max(100),
  redirect_uris: z.array(z.string().url()).min(1),
  scopes: z.array(z.string()).optional(),
});

/**
 * OAuth 2.0 Authorization Endpoint
 * GET /oauth/authorize
 * 
 * This endpoint initiates the authorization flow.
 * In a full implementation, this would render a login/consent page.
 * For API usage, the user should be pre-authenticated.
 */
oauthRouter.get('/authorize', oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const query = authorizeQuerySchema.parse(req.query);
    const db = getDatabase();
    const oauthService = new OAuthService(db);

    // Validate client
    const client = await oauthService.getClient(query.client_id);
    if (!client) {
      return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client' });
    }

    // Validate redirect URI
    const validRedirect = await oauthService.validateRedirectUri(query.client_id, query.redirect_uri);
    if (!validRedirect) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Redirect URI not registered' });
    }

    // Check if user is authenticated via session
    const sessionId = req.cookies?.session_id;
    if (!sessionId) {
      // Redirect to login with return URL
      const returnUrl = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?return_to=${returnUrl}`);
    }

    const userId = await oauthService.validateSession(sessionId);
    if (!userId) {
      const returnUrl = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?return_to=${returnUrl}`);
    }

    // Parse requested scopes
    const requestedScopes = query.scope?.split(' ') || ['read'];
    const allowedScopes = JSON.parse(client.scopes) as string[];
    const grantedScopes = requestedScopes.filter(s => allowedScopes.includes(s));

    // Create authorization code
    const code = await oauthService.createAuthorizationCode({
      clientId: query.client_id,
      userId,
      redirectUri: query.redirect_uri,
      scopes: grantedScopes,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
    });

    // Build redirect URL with code
    const redirectUrl = new URL(query.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (query.state) {
      redirectUrl.searchParams.set('state', query.state);
    }

    res.redirect(redirectUrl.toString());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'invalid_request', 
        error_description: 'Invalid request parameters',
        details: error.errors,
      });
    }
    console.error('Error in authorize:', error);
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/**
 * OAuth 2.0 Token Endpoint
 * POST /oauth/token
 * 
 * Exchange authorization code for access token, or refresh access token.
 */
oauthRouter.post('/token', authRateLimit, async (req: Request, res: Response) => {
  try {
    const body = tokenBodySchema.parse(req.body);
    const db = getDatabase();
    const oauthService = new OAuthService(db);

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri) {
        return res.status(400).json({ 
          error: 'invalid_request', 
          error_description: 'code and redirect_uri are required for authorization_code grant' 
        });
      }

      const tokens = await oauthService.exchangeAuthorizationCode({
        code: body.code,
        clientId: body.client_id,
        clientSecret: body.client_secret,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });

      if (!tokens) {
        return res.status(400).json({ 
          error: 'invalid_grant', 
          error_description: 'Invalid or expired authorization code' 
        });
      }

      return res.json(tokens);
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) {
        return res.status(400).json({ 
          error: 'invalid_request', 
          error_description: 'refresh_token is required for refresh_token grant' 
        });
      }

      const tokens = await oauthService.refreshAccessToken({
        refreshToken: body.refresh_token,
        clientId: body.client_id,
        clientSecret: body.client_secret,
      });

      if (!tokens) {
        return res.status(400).json({ 
          error: 'invalid_grant', 
          error_description: 'Invalid or expired refresh token' 
        });
      }

      return res.json(tokens);
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'invalid_request', 
        error_description: 'Invalid request body',
        details: error.errors,
      });
    }
    console.error('Error in token:', error);
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/**
 * OAuth 2.0 Token Revocation Endpoint
 * POST /oauth/revoke
 */
oauthRouter.post('/revoke', async (req: Request, res: Response) => {
  try {
    const { token, token_type_hint } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
    }

    const db = getDatabase();
    const oauthService = new OAuthService(db);

    // Try to revoke as access token first
    await oauthService.revokeAccessToken(token);

    // Always return 200 OK as per RFC 7009
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in revoke:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Token Introspection Endpoint
 * POST /oauth/introspect
 * 
 * Validate a token and return its metadata.
 */
oauthRouter.post('/introspect', async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
    }

    const db = getDatabase();
    const oauthService = new OAuthService(db);
    const accountService = new AccountService(db);

    const tokenInfo = await oauthService.validateAccessToken(token);
    
    if (!tokenInfo) {
      return res.json({ active: false });
    }

    const user = await accountService.getUserById(tokenInfo.userId);

    res.json({
      active: true,
      client_id: tokenInfo.clientId,
      scope: tokenInfo.scopes.join(' '),
      sub: String(tokenInfo.userId),
      username: user?.username || user?.email,
    });
  } catch (error) {
    console.error('Error in introspect:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * User Info Endpoint
 * GET /oauth/userinfo
 * 
 * Returns information about the authenticated user.
 */
oauthRouter.get('/userinfo', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const token = authHeader.slice(7);
    const db = getDatabase();
    const oauthService = new OAuthService(db);
    const accountService = new AccountService(db);

    const tokenInfo = await oauthService.validateAccessToken(token);
    if (!tokenInfo) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const user = await accountService.getUserById(tokenInfo.userId);
    if (!user) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    // Return claims based on scopes
    const claims: Record<string, any> = {
      sub: String(user.id),
    };

    if (tokenInfo.scopes.includes('profile') || tokenInfo.scopes.includes('read')) {
      claims.preferred_username = user.username;
      claims.name = user.display_name;
      claims.picture = user.avatar_url;
    }

    if (tokenInfo.scopes.includes('email') || tokenInfo.scopes.includes('read')) {
      claims.email = user.email;
      claims.email_verified = Boolean(user.email_verified);
    }

    res.json(claims);
  } catch (error) {
    console.error('Error in userinfo:', error);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Register OAuth Client (admin endpoint)
 * POST /oauth/clients
 */
oauthRouter.post('/clients', async (req: Request, res: Response) => {
  try {
    // Check for admin API key
    const adminKey = process.env.ADMIN_API_KEY;
    const authHeader = req.headers.authorization;
    
    if (!adminKey || !authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== adminKey) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const body = registerClientSchema.parse(req.body);
    const db = getDatabase();
    const oauthService = new OAuthService(db);

    const { clientId, clientSecret } = await oauthService.registerClient({
      name: body.name,
      redirectUris: body.redirect_uris,
      scopes: body.scopes,
    });

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      message: 'Store the client_secret securely. It cannot be retrieved again.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error registering client:', error);
    res.status(500).json({ error: 'Failed to register client' });
  }
});

/**
 * OpenID Connect Discovery Document
 * GET /.well-known/openid-configuration
 */
oauthRouter.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
  const baseUrl = process.env.PAYMENT_SERVICE_URL || `${req.protocol}://${req.get('host')}`;
  
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    introspection_endpoint: `${baseUrl}/oauth/introspect`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['read', 'write', 'profile', 'email'],
    claims_supported: ['sub', 'email', 'email_verified', 'name', 'preferred_username', 'picture'],
  });
});
