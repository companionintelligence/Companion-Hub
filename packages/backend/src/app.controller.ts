import { resolveAppDataHostRoot } from '@/common/helpers/app-data-path.helper';
import { ConfigurationService } from '@/core/config/configuration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AcknowledgeWelcomeBody, AppContextDto, UserSettingsBody, UserContextDto } from './app.dto';
import { AppService } from './app.service';
import { AppsService } from './modules/apps/apps.service';
import { AuthGuard } from './modules/auth/auth.guard';
import { MarketplaceService } from './modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import type { UserDto } from './modules/user/dto/user.dto';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LoggerService } from '@/core/logger/logger.service';
import { TranslatableError } from '@/common/error/translatable-error';
import { CloudflareClientService } from './modules/cloudflare/cloudflare-client.service';
import { TailscaleService } from './modules/tailscale/tailscale.service';
import { AppStoreService } from './modules/app-stores/app-store.service';
import { buildTailscaleNodeFqdn } from '@ci-hub/common/types';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly userRepository: UserRepository,
    private readonly configuration: ConfigurationService,
    private readonly appsService: AppsService,
    private readonly marketplaceService: MarketplaceService,
    private readonly logger: LoggerService,
    private readonly registrationService: RegistrationService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly tailscaleService: TailscaleService,
    private readonly appStoreService: AppStoreService,
  ) {}

  @Get('/user-context')
  @ApiResponse({ type: UserContextDto })
  async userContext(@Req() req: Request) {
    const configuredLocalDomain = this.configuration.get('localDomain');
    const configuredDomain = this.configuration.get('domain') ?? '';

    // Default values to use if anything fails
    const defaults = {
      isLoggedIn: false,
      isConfigured: false,
      isGuestDashboardEnabled: false,
      isPasswordResetDisabled: true,
      allowAutoThemes: true,
      allowErrorMonitoring: true,
      themeColor: 'blue',
      themeBase: 'gray',
      localDomain: configuredLocalDomain,
      domain: configuredDomain,
      sslPort: 443,
      version: {
        current: '0.0.0',
        latest: '0.0.0',
        body: '',
        releases: [] as { version: string; body: string }[],
      },
    };

    try {
      // Try to get user settings
      // biome-ignore lint/suspicious/noExplicitAny: Configuration service returns untyped data
      let userSettings: any;
      try {
        userSettings = this.configuration.get('userSettings');
      } catch (error) {
        this.logger.error('Failed to get userSettings:', error);
        userSettings = {};
      }

      const { guestDashboard, disablePasswordReset, allowAutoThemes, themeColor, themeBase, allowErrorMonitoring } = userSettings || {};

      // Ensure required fields have defaults (prefer resolved config over hardcoded fallbacks)
      const localDomain = userSettings?.localDomain?.trim() || configuredLocalDomain;
      const domain = userSettings?.domain?.trim() || configuredDomain;
      const sslPort = userSettings?.sslPort ?? defaults.sslPort;

      // Get version with error handling (GitHub API might be unavailable)
      let version = defaults.version;
      try {
        version = await this.appService.getVersion();
      } catch (_error) {
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
        domain,
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
      // biome-ignore lint/suspicious/noExplicitAny: Fallback object
      let defaultSettings: any = {};

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
        localDomain: defaultSettings?.localDomain?.trim() || configuredLocalDomain,
        domain: defaultSettings?.domain?.trim() || configuredDomain,
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

  @Get('store/alternatives')
  @ApiOperation({ summary: 'Open-source app alternatives catalog (proxied from CI Cloud)' })
  @ApiResponse({ status: 200, description: 'Alternatives JSON' })
  @ApiResponse({ status: 503, description: 'CI Cloud unreachable or CI_CLOUD_URL not set' })
  async getStoreAlternatives() {
    return this.appStoreService.fetchCiCloudStoreAlternatives();
  }

  @Get('store/listings')
  @ApiOperation({ summary: 'App store listings (proxied from CI Cloud)' })
  @ApiResponse({ status: 200, description: 'Store apps JSON array' })
  @ApiResponse({ status: 503, description: 'CI Cloud unreachable or CI_CLOUD_URL not set' })
  async getStoreListings(
    @Query('tags') tags?: string,
    @Query('sort') sort?: 'newest' | 'trending',
    @Query('category') category?: string,
    @Query('q') q?: string,
  ) {
    return this.appStoreService.fetchCiCloudStoreListings({ tags, sort, category, q });
  }

  @Get('/app-context')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppContextDto })
  async appContext(@Req() req: Request) {
    const { userSettings, isProduction, rootFolderHost } = this.configuration.getConfig();

    // Resolve the host path of the root app-data folder so the desktop app can
    // open it in the OS file explorer. Best-effort: never fail the context over it.
    let appDataRootHostPath: string | null = null;
    try {
      appDataRootHostPath = resolveAppDataHostRoot({
        // Mirror the precedence used during compose generation (app.helpers.ts):
        // CI_HUB_APP_DATA_PATH env override → userSettings.appDataPath → ROOT_FOLDER_HOST.
        ciHubAppDataPath: process.env.CI_HUB_APP_DATA_PATH,
        appDataPath: userSettings.appDataPath,
        rootFolderHost,
      });
    } catch (error) {
      this.logger.warn(`Could not resolve app data root host path: ${error}`);
    }

    // Parallelize all independent async calls
    const [version, org, apps, installedApps, tailscaleStatus] = await Promise.all([
      this.appService.getVersion(),
      this.registrationService.getDeviceRegistrationInfo(),
      this.marketplaceService.getAvailableApps(),
      this.appsService.getInstalledApps(),
      this.tailscaleService.getStatus().catch(() => ({
        installed: false,
        connected: false,
        hostname: null,
        nodeFqdn: null,
        tailnet: null,
        supportsServices: false,
        httpsAvailable: false,
      })),
    ]);

    const updatesAvailable = installedApps.filter(({ app, metadata }) => {
      return Number(app.version) < Number(metadata?.latestVersion ?? 0) && app.status !== 'updating';
    });

    // Extract slug from domain
    const orgSlug = org?.slug;
    const orgLabel = org?.name;
    const deviceSlug = org?.hubSubdomain?.replace(/^hub-/, '').replace(new RegExp(`-${orgSlug}$`), '') || '';

    // Check service availability
    const cloudflareAvailable = Boolean(this.cloudflareClientService.getTunnelToken());
    const tailscaleAvailable = tailscaleStatus.installed && tailscaleStatus.connected;
    const tailscaleNodeFqdn = tailscaleAvailable
      ? tailscaleStatus.nodeFqdn || buildTailscaleNodeFqdn(tailscaleStatus.hostname, tailscaleStatus.tailnet)
      : null;

    return AppContextDto.parse(
      {
        version,
        userSettings: { ...userSettings, ciHubOrganizationSlug: orgSlug, ciHubOrganizationLabel: orgLabel, ciHubDeviceSlug: deviceSlug },
        appDataRootHostPath,
        user: req.user as UserDto,
        apps,
        updatesAvailable: updatesAvailable.length,
        isProduction,
        cloudflareAvailable,
        tailscaleAvailable,
        tailscaleNodeFqdn,
        tailscaleSupportsServices: Boolean(tailscaleStatus.supportsServices),
        tailscaleHttpsEnabled: Boolean(tailscaleStatus.httpsAvailable),
      },
      { reportOnly: true },
    );
  }

  @Patch('/user-settings')
  @UseGuards(AuthGuard)
  async updateUserSettings(@Body() body: UserSettingsBody) {
    await this.configuration.setUserSettings(body);
  }

  @Patch('/user-advanced-mode')
  @UseGuards(AuthGuard)
  async updateAdvancedMode(@Req() req: Request, @Body() body: { advancedMode: boolean }) {
    if (!req.user) {
      throw new TranslatableError('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    }

    await this.userRepository.updateUser(req.user.id, { advancedMode: Boolean(body.advancedMode) });
  }

  @Patch('/acknowledge-welcome')
  @UseGuards(AuthGuard)
  async acknowledgeWelcome(@Req() req: Request, @Body() body: AcknowledgeWelcomeBody) {
    if (!req.user) {
      return;
    }

    await this.userRepository.updateUser(req.user.id, { hasCompletedOnboarding: true });

    if (this.configuration.get('demoMode')) {
      return;
    }

    await this.configuration.setUserSettings({ allowErrorMonitoring: body.allowErrorMonitoring });
  }

  @Patch('/complete-onboarding')
  @UseGuards(AuthGuard)
  async completeOnboarding(@Req() req: Request) {
    if (!req.user) {
      return;
    }
    await this.userRepository.updateUser(req.user.id, { hasCompletedOnboarding: true });
  }

  /** Re-arm the first-time setup wizard so the user can run it again from Settings. */
  @Patch('/restart-onboarding')
  @UseGuards(AuthGuard)
  async restartOnboarding(@Req() req: Request) {
    if (!req.user) {
      return;
    }
    await this.userRepository.updateUser(req.user.id, { hasCompletedOnboarding: false });
  }
}
