import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase } from '../database.js';
import { AccountService } from '../services/account.js';
import { OAuthService } from '../services/oauth.js';

export const accountRouter = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  username: z.string().min(3).max(30).optional(),
  display_name: z.string().max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const updateProfileSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  display_name: z.string().max(100).optional(),
  avatar_url: z.string().url().optional(),
});

const changePasswordSchema = z.object({
  current_password: z.string(),
  new_password: z.string().min(8),
});

/**
 * Middleware to authenticate user via session or OAuth token
 */
async function authenticateUser(req: Request, res: Response, next: Function) {
  const db = getDatabase();
  const oauthService = new OAuthService(db);

  // Check for session cookie
  const sessionId = req.cookies?.session_id;
  if (sessionId) {
    const userId = await oauthService.validateSession(sessionId);
    if (userId) {
      (req as any).userId = userId;
      return next();
    }
  }

  // Check for OAuth Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const tokenInfo = await oauthService.validateAccessToken(token);
    if (tokenInfo) {
      (req as any).userId = tokenInfo.userId;
      (req as any).scopes = tokenInfo.scopes;
      return next();
    }
  }

  res.status(401).json({ error: 'Authentication required' });
}

// Register new account
accountRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);
    const db = getDatabase();
    const accountService = new AccountService(db);

    const user = await accountService.createUser({
      email: body.email,
      password: body.password,
      username: body.username,
      display_name: body.display_name,
    });

    // Create session
    const oauthService = new OAuthService(db);
    const sessionId = await oauthService.createSession(
      user.id,
      req.ip,
      req.headers['user-agent']
    );

    // Set session cookie
    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({
      user: accountService.getPublicProfile(user),
      session_id: sessionId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    if (error instanceof Error && error.message.includes('already')) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Error registering user:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
accountRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body);
    const db = getDatabase();
    const accountService = new AccountService(db);

    const user = await accountService.authenticateUser(body.email, body.password);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Create session
    const oauthService = new OAuthService(db);
    const sessionId = await oauthService.createSession(
      user.id,
      req.ip,
      req.headers['user-agent']
    );

    // Set session cookie
    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      user: accountService.getPublicProfile(user),
      session_id: sessionId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout
accountRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const sessionId = req.cookies?.session_id;
    
    if (sessionId) {
      const db = getDatabase();
      const oauthService = new OAuthService(db);
      await oauthService.deleteSession(sessionId);
    }

    res.clearCookie('session_id');
    res.json({ success: true });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Get current user profile
accountRouter.get('/me', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const db = getDatabase();
    const accountService = new AccountService(db);

    const user = await accountService.getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: accountService.getPublicProfile(user),
    });
  } catch (error) {
    console.error('Error getting profile:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update profile
accountRouter.patch('/me', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const body = updateProfileSchema.parse(req.body);
    const db = getDatabase();
    const accountService = new AccountService(db);

    const user = await accountService.updateUser(userId, body);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: accountService.getPublicProfile(user),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    if (error instanceof Error && error.message.includes('already taken')) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change password
accountRouter.post('/me/password', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const body = changePasswordSchema.parse(req.body);
    const db = getDatabase();
    const accountService = new AccountService(db);

    const success = await accountService.changePassword(
      userId,
      body.current_password,
      body.new_password
    );
    
    if (!success) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Get user's app entitlements
accountRouter.get('/me/entitlements', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const db = getDatabase();
    const accountService = new AccountService(db);

    const entitlements = await accountService.getUserEntitlements(userId);
    res.json({ entitlements });
  } catch (error) {
    console.error('Error getting entitlements:', error);
    res.status(500).json({ error: 'Failed to get entitlements' });
  }
});

// Check entitlement for a specific app
accountRouter.get('/me/entitlements/:appUrn', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { appUrn } = req.params;
    const db = getDatabase();
    const accountService = new AccountService(db);

    const hasAccess = await accountService.hasEntitlement(userId, appUrn);
    res.json({ hasAccess, appUrn });
  } catch (error) {
    console.error('Error checking entitlement:', error);
    res.status(500).json({ error: 'Failed to check entitlement' });
  }
});

// Delete account
accountRouter.delete('/me', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const db = getDatabase();
    const accountService = new AccountService(db);

    const success = await accountService.deleteUser(userId);
    
    if (!success) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.clearCookie('session_id');
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Logout from all devices
accountRouter.post('/me/logout-all', authenticateUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const db = getDatabase();
    const oauthService = new OAuthService(db);

    await oauthService.deleteUserSessions(userId);
    await oauthService.revokeUserTokens(userId);

    res.clearCookie('session_id');
    res.json({ success: true });
  } catch (error) {
    console.error('Error logging out from all devices:', error);
    res.status(500).json({ error: 'Failed to logout from all devices' });
  }
});

export { authenticateUser };
