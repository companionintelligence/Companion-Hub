import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import si from 'systeminformation';
import { RegistrationRepository } from './registration.repository';

@Injectable()
export class RegistrationService implements OnApplicationBootstrap {
  private _isRegistered = false;
  private _registrationUrl = '';
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly registrationRepository: RegistrationRepository,
  ) {}

  async onApplicationBootstrap() {
    await this.checkRegistrationStatus();
  }

  public async getDeviceId(): Promise<string> {
    if (process.env.NODE_ENV === 'development') {
      return 'test-device-id';
    }
    return (await si.uuid()).hardware;
  }

  public async isRegistered(): Promise<boolean> {
    return this._isRegistered;
  }
  
  public getRegistrationUrl(): string {
      return this._registrationUrl;
  }

  private async checkRegistrationStatus() {
    this.logger.info('Checking registration status...');
    const registration = await this.registrationRepository.getRegistration();
    const deviceId = await this.getDeviceId();
    const { ciCloudAppStoreUrl } = this.config.getConfig();
    
    let cloudBaseUrl = '';
    try {
        const urlObj = new URL(ciCloudAppStoreUrl!);
        cloudBaseUrl = urlObj.origin;
    } catch (e) {
        this.logger.warn('Invalid CI Cloud URL, cannot construct registration URL');
    }
    
    this._registrationUrl = `${cloudBaseUrl}/device/register?device_id=${deviceId}`;

    if (!registration) {
      this.logger.info('Device is not registered locally.');
      this._isRegistered = false;
      return;
    }

    this.logger.info(`Device found in local DB. Verifying with cloud...`);
    
    try {
        const response = await fetch(`${cloudBaseUrl}/api/web/license-check`, {
            headers: {
                'X-Device-ID': deviceId
            }
        });
        
        if (!response.ok) {
             if (response.status === 404 || response.status === 403) {
                 this.logger.warn('Cloud says device is not registered.');
                 this._isRegistered = false;
                 await this.registrationRepository.deleteRegistration(registration.id);
                 return;
             }
             throw new Error(`Cloud returned ${response.status}`);
        }

        const data = await response.json() as { registrationId: string, subdomain: string };
        const { registrationId, subdomain } = data;
        
        if (registration.registrationId !== registrationId || registration.subdomain !== subdomain) {
            this.logger.warn('Local registration does not match cloud record. Resetting registration.');
            this._isRegistered = false;
            await this.registrationRepository.deleteRegistration(registration.id);
        } else {
            this.logger.info('Device registration verified successfully.');
            this._isRegistered = true;
            this.startHeartbeat(cloudBaseUrl, deviceId);
        }
        
    } catch (error) {
        this.logger.error('Error verifying registration with cloud:', error);
        this.logger.warn('Could not verify with cloud, assuming local registration is valid for now.');
        this._isRegistered = true;
        // Still start heartbeat in case it comes back online? 
        // Or maybe retry verification later?
        // For now, let's try to start heartbeat, it might fail but that's fine.
        this.startHeartbeat(cloudBaseUrl, deviceId);
    }
  }

  private startHeartbeat(cloudBaseUrl: string, deviceId: string) {
      if (this.checkInterval) {
          clearInterval(this.checkInterval);
      }
      
      const heartbeat = async () => {
          try {
              await fetch(`${cloudBaseUrl}/api/devices/check-in`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ device_id: deviceId })
              });
          } catch (e) {
              this.logger.debug('Heartbeat failed', e);
          }
      };
      
      // Run immediately then every 5 minutes
      heartbeat();
      this.checkInterval = setInterval(heartbeat, 5 * 60 * 1000);
  }
  
  public async completeRegistration(subdomain: string, registrationId: string) {
      const deviceId = await this.getDeviceId();
      const existing = await this.registrationRepository.getRegistration();
      if (existing) {
          await this.registrationRepository.updateRegistration(existing.id, {
              subdomain,
              registrationId,
              deviceId
          });
      } else {
          await this.registrationRepository.createRegistration({
              deviceId,
              subdomain,
              registrationId
          });
      }
      this._isRegistered = true;
      await this.checkRegistrationStatus();
  }
}
