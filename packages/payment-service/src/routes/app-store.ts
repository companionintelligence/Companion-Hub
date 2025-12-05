import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase } from '../database.js';
import { AppStoreService } from '../services/app-store.js';
import { authenticateRequest } from '../middleware/auth.js';

export const appStoreRouter = Router();

const appStoreService = new AppStoreService();

// Public endpoint - list available apps
appStoreRouter.get('/apps', async (req: Request, res: Response) => {
  try {
    if (!appStoreService.isConfigured()) {
      return res.status(503).json({ 
        error: 'App store not configured', 
        message: 'GitHub credentials not set' 
      });
    }

    const apps = await appStoreService.listApps();
    res.json({ apps });
  } catch (error) {
    console.error('Error listing apps:', error);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// Public endpoint - get app config (pricing info visible to all)
appStoreRouter.get('/apps/:appUrn/config', async (req: Request, res: Response) => {
  try {
    const { appUrn } = req.params;
    
    if (!appStoreService.isConfigured()) {
      return res.status(503).json({ error: 'App store not configured' });
    }

    const config = await appStoreService.getAppConfig(appUrn);
    
    if (!config) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json(config);
  } catch (error) {
    console.error('Error getting app config:', error);
    res.status(500).json({ error: 'Failed to get app config' });
  }
});

// Protected endpoint - check access to an app
appStoreRouter.get('/apps/:appUrn/access/:userId', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const { appUrn, userId } = req.params;
    const db = getDatabase();
    
    if (!appStoreService.isConfigured()) {
      return res.status(503).json({ error: 'App store not configured' });
    }

    const access = await appStoreService.checkAppAccess(appUrn, parseInt(userId), db);
    res.json(access);
  } catch (error) {
    console.error('Error checking app access:', error);
    res.status(500).json({ error: 'Failed to check app access' });
  }
});

// Protected endpoint - get docker-compose for paid apps (requires payment verification)
appStoreRouter.get('/apps/:appUrn/docker-compose', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const { appUrn } = req.params;
    const userId = parseInt(req.query.userId as string);
    
    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: 'userId query parameter required' });
    }

    if (!appStoreService.isConfigured()) {
      return res.status(503).json({ error: 'App store not configured' });
    }

    const db = getDatabase();
    const result = await appStoreService.getDockerCompose(appUrn, userId, db);
    
    if (result.error) {
      // Check if payment is required
      const access = await appStoreService.checkAppAccess(appUrn, userId, db);
      if (access.paymentRequired) {
        return res.status(402).json({ 
          error: 'Payment required',
          pricingInfo: access.pricingInfo,
        });
      }
      return res.status(403).json({ error: result.error });
    }

    res.json({
      dockerCompose: result.dockerCompose,
      paymentKey: result.paymentKey,
    });
  } catch (error) {
    console.error('Error getting docker-compose:', error);
    res.status(500).json({ error: 'Failed to get docker-compose' });
  }
});

// Protected endpoint - verify a payment key
appStoreRouter.post('/verify-key', authenticateRequest, async (req: Request, res: Response) => {
  try {
    const body = z.object({
      paymentKey: z.string(),
    }).parse(req.body);

    const result = appStoreService.verifyPaymentKey(body.paymentKey);
    
    if (!result.valid) {
      return res.status(401).json({ 
        valid: false, 
        reason: result.reason 
      });
    }

    res.json({
      valid: true,
      appUrn: result.appUrn,
      userId: result.userId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request body', details: error.errors });
    }
    console.error('Error verifying payment key:', error);
    res.status(500).json({ error: 'Failed to verify payment key' });
  }
});

// Health check for app store service
appStoreRouter.get('/status', (req: Request, res: Response) => {
  res.json({
    configured: appStoreService.isConfigured(),
    repo: process.env.GITHUB_APP_STORE_REPO || 'companionintelligence/CI-App-Store',
  });
});
