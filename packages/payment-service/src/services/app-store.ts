/**
 * App Store Service
 * Manages app store proxy through payment-service with DRM enforcement
 * Apps are fetched from a private GitHub repository and access is controlled
 * based on payment status.
 */

interface AppConfig {
  id: string;
  name: string;
  urn: string;
  pricing?: {
    type: 'free' | 'one_time' | 'subscription';
    price?: number;
    currency?: string;
    interval?: 'monthly' | 'yearly';
    payment_methods?: Array<'stripe' | 'x402'>;
  };
  docker_compose?: string;
  [key: string]: unknown;
}

interface AppAccessResult {
  hasAccess: boolean;
  reason?: string;
  paymentRequired?: boolean;
  pricingInfo?: AppConfig['pricing'];
}

export class AppStoreService {
  private githubToken: string | undefined;
  private githubRepo: string;
  private githubBranch: string;
  private appCache: Map<string, { config: AppConfig; cachedAt: number }> = new Map();
  private cacheTtl: number = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.githubToken = process.env.GITHUB_APP_STORE_TOKEN;
    this.githubRepo = process.env.GITHUB_APP_STORE_REPO || 'companionintelligence/CI-App-Store';
    this.githubBranch = process.env.GITHUB_APP_STORE_BRANCH || 'main';
  }

  /**
   * Fetch raw content from GitHub private repo
   */
  private async fetchFromGitHub(path: string): Promise<string | null> {
    if (!this.githubToken) {
      throw new Error('GitHub token not configured for app store access');
    }

    const url = `https://raw.githubusercontent.com/${this.githubRepo}/${this.githubBranch}/${path}`;
    
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `token ${this.githubToken}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'CI-OS-Payment-Service',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      console.error(`Failed to fetch from GitHub: ${path}`, error);
      throw error;
    }
  }

  /**
   * Get app configuration by URN
   */
  async getAppConfig(appUrn: string): Promise<AppConfig | null> {
    // Check cache first
    const cached = this.appCache.get(appUrn);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtl) {
      return cached.config;
    }

    try {
      // Fetch config.json from the app's directory in the repo
      const configPath = `apps/${appUrn}/config.json`;
      const configContent = await this.fetchFromGitHub(configPath);
      
      if (!configContent) {
        console.warn(`App config not found: ${appUrn}`);
        return null;
      }

      const config = JSON.parse(configContent) as AppConfig;
      
      // Cache the config
      this.appCache.set(appUrn, { config, cachedAt: Date.now() });
      
      return config;
    } catch (error) {
      console.error(`Failed to get app config: ${appUrn}`, error);
      throw error;
    }
  }

  /**
   * Check if user has access to an app based on payment status
   */
  async checkAppAccess(appUrn: string, userId: number, db: any): Promise<AppAccessResult> {
    const config = await this.getAppConfig(appUrn);
    
    if (!config) {
      return { hasAccess: false, reason: 'App not found' };
    }

    // Free apps always have access
    if (!config.pricing || config.pricing.type === 'free') {
      return { hasAccess: true };
    }

    // Check payment status for paid apps
    const paymentCheck = db.prepare(`
      SELECT * FROM payments 
      WHERE app_urn = ? AND user_id = ? AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(appUrn, userId);

    if (paymentCheck) {
      return { hasAccess: true };
    }

    // Check active subscription for subscription apps
    if (config.pricing.type === 'subscription') {
      const subscription = db.prepare(`
        SELECT * FROM subscriptions 
        WHERE app_urn = ? AND user_id = ? AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(appUrn, userId);

      if (subscription) {
        // Check if subscription is still valid
        const periodEnd = new Date(subscription.current_period_end);
        if (periodEnd > new Date()) {
          return { hasAccess: true };
        }
      }
    }

    return {
      hasAccess: false,
      reason: 'Payment required',
      paymentRequired: true,
      pricingInfo: config.pricing,
    };
  }

  /**
   * Generate a signed payment key for accessing paid app resources
   * This key is short-lived and tied to the user and app
   */
  generatePaymentKey(appUrn: string, userId: number): string {
    const timestamp = Date.now();
    const expiresAt = timestamp + (24 * 60 * 60 * 1000); // 24 hours
    const payload = {
      appUrn,
      userId,
      timestamp,
      expiresAt,
    };
    
    // In production, this should use proper JWT signing with a secret
    // For now, we use base64 encoding with a simple hash
    const secret = process.env.PAYMENT_KEY_SECRET || 'default-secret-change-in-production';
    const data = JSON.stringify(payload);
    const signature = this.simpleHash(`${data}${secret}`);
    
    return Buffer.from(JSON.stringify({ ...payload, signature })).toString('base64url');
  }

  /**
   * Verify a payment key is valid
   */
  verifyPaymentKey(key: string): { valid: boolean; appUrn?: string; userId?: number; reason?: string } {
    try {
      const decoded = JSON.parse(Buffer.from(key, 'base64url').toString());
      const { appUrn, userId, timestamp, expiresAt, signature } = decoded;
      
      // Check expiration
      if (Date.now() > expiresAt) {
        return { valid: false, reason: 'Payment key expired' };
      }
      
      // Verify signature
      const secret = process.env.PAYMENT_KEY_SECRET || 'default-secret-change-in-production';
      const expectedSignature = this.simpleHash(`${JSON.stringify({ appUrn, userId, timestamp, expiresAt })}${secret}`);
      
      if (signature !== expectedSignature) {
        return { valid: false, reason: 'Invalid payment key signature' };
      }
      
      return { valid: true, appUrn, userId };
    } catch {
      return { valid: false, reason: 'Malformed payment key' };
    }
  }

  /**
   * Simple hash function for signing (use crypto in production)
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get docker-compose.json for an app (only if user has access)
   */
  async getDockerCompose(appUrn: string, userId: number, db: any): Promise<{
    dockerCompose: string | null;
    paymentKey?: string;
    error?: string;
  }> {
    const access = await this.checkAppAccess(appUrn, userId, db);
    
    if (!access.hasAccess) {
      return {
        dockerCompose: null,
        error: access.reason || 'Access denied',
      };
    }

    try {
      const composePath = `apps/${appUrn}/docker-compose.json`;
      const composeContent = await this.fetchFromGitHub(composePath);
      
      if (!composeContent) {
        // Try docker-compose.yml as fallback
        const ymlPath = `apps/${appUrn}/docker-compose.yml`;
        const ymlContent = await this.fetchFromGitHub(ymlPath);
        
        if (!ymlContent) {
          return { dockerCompose: null, error: 'Docker compose file not found' };
        }
        
        const paymentKey = this.generatePaymentKey(appUrn, userId);
        return { dockerCompose: ymlContent, paymentKey };
      }
      
      const paymentKey = this.generatePaymentKey(appUrn, userId);
      return { dockerCompose: composeContent, paymentKey };
    } catch (error) {
      console.error(`Failed to get docker-compose for ${appUrn}:`, error);
      return { dockerCompose: null, error: 'Failed to fetch docker compose' };
    }
  }

  /**
   * List all available apps from the store
   */
  async listApps(): Promise<string[]> {
    try {
      // Fetch the apps directory listing from GitHub API
      if (!this.githubToken) {
        throw new Error('GitHub token not configured');
      }

      const url = `https://api.github.com/repos/${this.githubRepo}/contents/apps?ref=${this.githubBranch}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `token ${this.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'CI-OS-Payment-Service',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const contents = await response.json() as Array<{ name: string; type: string }>;
      return contents.filter(item => item.type === 'dir').map(item => item.name);
    } catch (error) {
      console.error('Failed to list apps:', error);
      throw error;
    }
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured(): boolean {
    return Boolean(this.githubToken);
  }
}
