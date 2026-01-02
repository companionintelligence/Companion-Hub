import { ConfigurationService } from '@/core/config/configuration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AcknowledgeWelcomeBody, AppContextDto, UserSettingsBody, UserContextDto } from './app.dto';
import { AppService } from './app.service';
import { AppsService } from './modules/apps/apps.service';
import { AuthGuard } from './modules/auth/auth.guard';
import { MarketplaceService } from './modules/marketplace/marketplace.service';
import type { UserDto } from './modules/user/dto/user.dto';
import { ApiResponse } from '@nestjs/swagger';
import { LoggerService } from '@/core/logger/logger.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly userRepository: UserRepository,
    private readonly configuration: ConfigurationService,
    private readonly appsService: AppsService,
    private readonly marketplaceService: MarketplaceService,
    private readonly logger: LoggerService,
  ) {}

  @Get('/user-context')
  @ApiResponse({ type: UserContextDto })
  async userContext(@Req() req: Request) {
    // Default values to use if anything fails
    const defaults = {
      isLoggedIn: false,
      isConfigured: false,
      isGuestDashboardEnabled: false,
      isPasswordResetDisabled: true,
      allowAutoThemes: true,
      allowErrorMonitoring: false,
      themeColor: 'blue',
      themeBase: 'gray',
      localDomain: 'tipi.lan',
      sslPort: 443,
      version: {
        current: '0.0.0',
        latest: '0.0.0',
        body: '',
        releases: [],
      },
    };

    try {
      // Try to get user settings
      let userSettings;
      try {
        userSettings = this.configuration.get('userSettings');
      } catch (error) {
        this.logger.error('Failed to get userSettings:', error);
        userSettings = {};
      }

      const { guestDashboard, disablePasswordReset, allowAutoThemes, themeColor, themeBase, allowErrorMonitoring } = userSettings || {};
      
      // Ensure required fields have defaults
      const localDomain = userSettings?.localDomain || defaults.localDomain;
      const sslPort = userSettings?.sslPort ?? defaults.sslPort;
      
      // Get version with error handling (GitHub API might be unavailable)
      let version = defaults.version;
      try {
        version = await this.appService.getVersion();
      } catch (error) {
        // Fallback to current version if GitHub API fails
        try {
          const { version: currentVersion } = this.configuration.getConfig();
          version = {
            current: currentVersion || defaults.version.current,
            latest: currentVersion || defaults.version.latest,
            body: '',
            releases: [],
          };
        } catch (configError) {
          this.logger.error('Failed to get version from config:', configError);
          // Use defaults
        }
      }

      // Get operator with error handling (database might not be ready)
      let operator = null;
      try {
        operator = await this.userRepository.getFirstOperator();
      } catch (error) {
        // Database might not be ready yet, return null
        this.logger.error('Failed to get first operator:', error);
      }

      const contextData = {
        isLoggedIn: Boolean(req.user),
        isConfigured: Boolean(operator),
        isGuestDashboardEnabled: guestDashboard ?? defaults.isGuestDashboardEnabled,
        isPasswordResetDisabled: disablePasswordReset ?? defaults.isPasswordResetDisabled,
        allowAutoThemes: allowAutoThemes ?? defaults.allowAutoThemes,
        allowErrorMonitoring: allowErrorMonitoring ?? defaults.allowErrorMonitoring,
        themeColor: themeColor || defaults.themeColor,
        themeBase: themeBase || defaults.themeBase,
        version,
        localDomain,
        sslPort,
      };

      // Try to parse with validation, but don't fail if it doesn't match
      try {
        return UserContextDto.parse(contextData, { reportOnly: true });
      } catch (parseError) {
        this.logger.error('Failed to parse UserContextDto, returning raw data:', parseError);
        // Return the data anyway - the frontend can handle it
        return contextData;
      }
    } catch (error) {
      // If everything fails, return minimal context to allow app to load
      this.logger.error('Error in userContext endpoint:', error);
      
      // Try to get minimal config, but don't fail if it doesn't work
      let currentVersion = defaults.version.current;
      let defaultSettings = {};
      
      try {
        const config = this.configuration.getConfig();
        currentVersion = config.version || defaults.version.current;
      } catch (configError) {
        this.logger.error('Failed to get config:', configError);
      }
      
      try {
        defaultSettings = this.configuration.get('userSettings') || {};
      } catch (settingsError) {
        this.logger.error('Failed to get userSettings:', settingsError);
      }
      
      const fallbackData = {
        isLoggedIn: Boolean(req.user),
        isConfigured: false,
        isGuestDashboardEnabled: defaultSettings?.guestDashboard ?? defaults.isGuestDashboardEnabled,
        isPasswordResetDisabled: defaultSettings?.disablePasswordReset ?? defaults.isPasswordResetDisabled,
        allowAutoThemes: defaultSettings?.allowAutoThemes ?? defaults.allowAutoThemes,
        allowErrorMonitoring: defaultSettings?.allowErrorMonitoring ?? defaults.allowErrorMonitoring,
        themeColor: defaultSettings?.themeColor || defaults.themeColor,
        themeBase: defaultSettings?.themeBase || defaults.themeBase,
        version: {
          current: currentVersion,
          latest: currentVersion,
          body: '',
          releases: [],
        },
        localDomain: defaultSettings?.localDomain || defaults.localDomain,
        sslPort: defaultSettings?.sslPort ?? defaults.sslPort,
      };

      // Try to parse, but return raw data if parsing fails
      try {
        return UserContextDto.parse(fallbackData, { reportOnly: true });
      } catch (parseError) {
        this.logger.error('Failed to parse fallback UserContextDto, returning raw data:', parseError);
        return fallbackData;
      }
    }
  }

  @Get('/app-context')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppContextDto })
  async appContext(@Req() req: Request) {
    const version = await this.appService.getVersion();

    const { userSettings, isProduction } = this.configuration.getConfig();

    const apps = await this.marketplaceService.getAvailableApps();

    const installedApps = await this.appsService.getInstalledApps();
    const updatesAvailable = installedApps.filter(({ app, metadata }) => {
      return Number(app.version) < Number(metadata?.latestVersion ?? 0) && app.status !== 'updating';
    });

    return AppContextDto.parse(
      { version, userSettings, user: req.user as UserDto, apps, updatesAvailable: updatesAvailable.length, isProduction },
      { reportOnly: true },
    );
  }

  @Patch('/user-settings')
  @UseGuards(AuthGuard)
  async updateUserSettings(@Body() body: UserSettingsBody) {
    await this.configuration.setUserSettings(body);
  }

  @Patch('/acknowledge-welcome')
  @UseGuards(AuthGuard)
  async acknowledgeWelcome(@Req() req: Request, @Body() body: AcknowledgeWelcomeBody) {
    if (!req.user) {
      return;
    }

    const version = await this.appService.getVersion();
    this.configuration.initSentry({ release: version.current, allowSentry: body.allowErrorMonitoring });
    await this.userRepository.updateUser(req.user.id, { hasSeenWelcome: true });

    if (this.configuration.get('demoMode')) {
      return;
    }

    await this.configuration.setUserSettings({ allowErrorMonitoring: body.allowErrorMonitoring });
  }
}
