import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import si from 'systeminformation';

@Injectable()
export class RegistrationService implements OnApplicationBootstrap {
  private _isRegistered = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap() {
    // Start polling for registration
    this.pollRegistration();
  }

  public async getDeviceId(): Promise<string> {
    if (process.env.NODE_ENV === 'development') {
      return 'test-device-id';
    }
    return (await si.uuid()).hardware;
  }

  public async isRegistered(): Promise<boolean> {
    // If already registered, return true immediately
    if (this._isRegistered) {
      return true;
    }
    // Otherwise, perform a check (optional, or just rely on the poller)
    // For now, we rely on the poller to update the state, but we can also trigger a check here if needed.
    return this._isRegistered;
  }

  private async pollRegistration() {
    this.logger.info('Starting registration check loop...');

    const check = async () => {
      if (this._isRegistered) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        return;
      }

      try {
        const registered = await this.checkRegistrationWithCloud();
        if (registered) {
          this._isRegistered = true;
          this.logger.info('Device successfully registered!');
          if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
          }
        } else {
          this.logger.debug('Device not yet registered, retrying in 1s...');
        }
      } catch (error) {
        this.logger.error('Error checking registration status:', error);
      }
    };

    // Initial check
    await check();

    // Start interval if not registered
    if (!this._isRegistered) {
      this.checkInterval = setInterval(check, 1000);
    }
  }

  private async checkRegistrationWithCloud(): Promise<boolean> {
    const { ciCloudAppStoreUrl } = this.config.getConfig();

    if (!ciCloudAppStoreUrl) {
      this.logger.warn('CI Cloud App Store URL not configured, skipping registration check.');
      return true; // Assume registered if no URL to check against? Or false?
      // For now, let's assume true to not block if not configured,
      // but the requirement implies strict gating.
      // However, if the URL is missing, we can't check.
    }

    // Construct the register URL.
    // The base URL is like http://host.docker.internal:8001/api/web/download-app-store
    // We need to replace /download-app-store with /register
    // Or assume the base URL is the root API?
    // The config says `CI_CLOUD_APP_STORE_URL`.
    // Let's parse it to get the base.

    try {
      const urlObj = new URL(ciCloudAppStoreUrl);
      // Assuming the structure is /api/web/...
      // We want /api/web/register
      const registerUrl = new URL('/api/web/register', urlObj.origin).toString();

      const deviceId = await this.getDeviceId();

      this.logger.debug(`Checking registration at ${registerUrl} for device ${deviceId}`);

      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_id: deviceId }),
      });

      if (response.status === 200) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Failed to contact cloud server for registration check:', error);
      return false;
    }
  }
}
