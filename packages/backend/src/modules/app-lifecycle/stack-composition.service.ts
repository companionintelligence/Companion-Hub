import { castAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { parseComposeJson } from '@ci-hub/common/schemas';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppsService } from '../apps/apps.service';
import { MarketplaceService } from '../marketplace/marketplace.service';

type StackRecipe = {
  id: string;
  name: string;
  description: string;
  apps: Array<{ urn: string; role: string; required: boolean }>;
  shared_config: {
    networks: string[];
    volumes: Record<string, string>;
    env_cross_refs: Record<string, string>;
  };
  min_resources: { ram_gb: number; disk_gb: number };
  estimated_setup: string;
  keywords: string[];
};

export interface CompositionPlan {
  apps: Array<{
    urn: string;
    role: string;
    required: boolean;
    configOverrides?: Record<string, string>;
    portOverrides?: Record<number, number>;
  }>;
  sharedNetworks: string[];
  sharedVolumes: Record<string, string>;
  envCrossRefs: Record<string, string>;
  resourceEstimate: { ramGb: number; diskGb: number };
}

const STACK_RECIPES: StackRecipe[] = [
  {
    id: 'media-server',
    name: 'Family Media Server',
    description: 'Stream movies, TV shows, and music to all your devices',
    apps: [
      { urn: 'jellyfin', role: 'primary', required: true },
      { urn: 'sonarr', role: 'tv-automation', required: false },
      { urn: 'radarr', role: 'movie-automation', required: false },
      { urn: 'prowlarr', role: 'indexer', required: false },
      { urn: 'qbittorrent', role: 'downloader', required: false },
    ],
    shared_config: {
      networks: ['media-net'],
      volumes: { media: '/data/media', downloads: '/data/downloads' },
      env_cross_refs: {
        'sonarr.JELLYFIN_HOST': 'jellyfin:8096',
        'radarr.JELLYFIN_HOST': 'jellyfin:8096',
      },
    },
    min_resources: { ram_gb: 4, disk_gb: 50 },
    estimated_setup: '5 minutes',
    keywords: ['media', 'movie', 'tv', 'jellyfin', 'sonarr', 'radarr'],
  },
  {
    id: 'ai-stack',
    name: 'AI Stack',
    description: 'Run local AI models with a web UI',
    apps: [
      { urn: 'ollama', role: 'primary', required: true },
      { urn: 'open-webui', role: 'chat-ui', required: false },
      { urn: 'flowise', role: 'workflow-builder', required: false },
    ],
    shared_config: {
      networks: ['ai-net'],
      volumes: { models: '/data/models' },
      env_cross_refs: {
        'open-webui.OLLAMA_BASE_URL': 'ollama:11434',
        'flowise.OLLAMA_HOST': 'ollama:11434',
      },
    },
    min_resources: { ram_gb: 8, disk_gb: 30 },
    estimated_setup: '5 minutes',
    keywords: ['ai', 'llm', 'ollama', 'open webui', 'flowise'],
  },
  {
    id: 'home-automation',
    name: 'Home Automation',
    description: 'Automate your home and device workflows',
    apps: [
      { urn: 'home-assistant', role: 'primary', required: true },
      { urn: 'mosquitto', role: 'mqtt-broker', required: false },
      { urn: 'zigbee2mqtt', role: 'zigbee-bridge', required: false },
      { urn: 'nodered', role: 'automation-flow', required: false },
    ],
    shared_config: {
      networks: ['home-net'],
      volumes: { automation: '/data/automation' },
      env_cross_refs: {
        'zigbee2mqtt.MQTT_SERVER': 'mqtt://mosquitto:1883',
        'nodered.MQTT_HOST': 'mosquitto:1883',
      },
    },
    min_resources: { ram_gb: 4, disk_gb: 20 },
    estimated_setup: '5 minutes',
    keywords: ['home', 'automation', 'assistant', 'mqtt', 'zigbee'],
  },
  {
    id: 'dev-environment',
    name: 'Development Environment',
    description: 'Self-hosted development workflow stack',
    apps: [
      { urn: 'gitea', role: 'primary', required: true },
      { urn: 'drone', role: 'ci', required: false },
      { urn: 'registry', role: 'container-registry', required: false },
    ],
    shared_config: {
      networks: ['dev-net'],
      volumes: { repos: '/data/repos', registry: '/data/registry' },
      env_cross_refs: {
        'drone.GITEA_SERVER': 'http://gitea:3000',
      },
    },
    min_resources: { ram_gb: 4, disk_gb: 30 },
    estimated_setup: '5 minutes',
    keywords: ['dev', 'development', 'gitea', 'drone', 'registry', 'git'],
  },
  {
    id: 'office-suite',
    name: 'Office Suite',
    description: 'Document editing and collaboration setup',
    apps: [
      { urn: 'onlyoffice', role: 'office', required: true },
      { urn: 'nextcloud', role: 'file-storage', required: false },
    ],
    shared_config: {
      networks: ['office-net'],
      volumes: { documents: '/data/documents' },
      env_cross_refs: {
        'onlyoffice.NEXTCLOUD_HOST': 'nextcloud:80',
      },
    },
    min_resources: { ram_gb: 4, disk_gb: 20 },
    estimated_setup: '5 minutes',
    keywords: ['office', 'documents', 'collabora', 'onlyoffice', 'nextcloud'],
  },
  {
    id: 'photo-management',
    name: 'Photo Management',
    description: 'AI-assisted photo management stack',
    apps: [{ urn: 'immich', role: 'primary', required: true }],
    shared_config: {
      networks: ['photo-net'],
      volumes: { photos: '/data/photos' },
      env_cross_refs: {},
    },
    min_resources: { ram_gb: 6, disk_gb: 40 },
    estimated_setup: '5 minutes',
    keywords: ['photo', 'photos', 'immich'],
  },
  {
    id: 'password-auth',
    name: 'Password + Auth',
    description: 'Password vault with optional SSO',
    apps: [
      { urn: 'vaultwarden', role: 'primary', required: true },
      { urn: 'authelia', role: 'sso', required: false },
    ],
    shared_config: {
      networks: ['auth-net'],
      volumes: { vault: '/data/vaultwarden' },
      env_cross_refs: {
        'authelia.VAULTWARDEN_URL': 'http://vaultwarden:80',
      },
    },
    min_resources: { ram_gb: 2, disk_gb: 10 },
    estimated_setup: '5 minutes',
    keywords: ['password', 'auth', 'vaultwarden', 'authelia', 'sso'],
  },
];

@Injectable()
export class StackCompositionService {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly appsService: AppsService,
    private readonly logger: LoggerService,
  ) {}

  public async composeStack(params: { request?: string; recipeId?: string; includeOptionalApps?: boolean; approved?: boolean; execute?: boolean }) {
    const recipe = this.resolveRecipe(params.recipeId, params.request);
    const includeOptionalApps = params.includeOptionalApps ?? true;
    const plan = recipe
      ? await this.buildPlanFromRecipe(recipe, includeOptionalApps)
      : await this.buildDynamicPlan(params.request ?? '', includeOptionalApps);

    const shouldExecute = Boolean(params.approved || params.execute);
    if (!shouldExecute) {
      return {
        recipe: recipe ? { id: recipe.id, name: recipe.name, description: recipe.description, estimatedSetup: recipe.estimated_setup } : null,
        plan,
        requiresApproval: true,
      };
    }

    const installs: Array<{ urn: string; success: boolean; requestId?: string; error?: string }> = [];
    for (const app of plan.apps) {
      try {
        const result = await this.appLifecycleService.installApp({
          appUrn: castAppUrn(app.urn),
          form: app.configOverrides ?? {},
        });
        installs.push({ urn: app.urn, success: true, requestId: result.requestId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        installs.push({ urn: app.urn, success: false, error: message });
        if (app.required) {
          break;
        }
      }
    }

    const health = await Promise.all(
      installs
        .filter((item) => item.success)
        .map(async (item) => {
          try {
            const status = await this.appsService.checkAppAvailability(castAppUrn(item.urn));
            return {
              urn: item.urn,
              available: status.available,
              url: status.appUrl,
              error: status.reason ?? status.detail,
            };
          } catch (error) {
            return {
              urn: item.urn,
              available: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    );

    return {
      recipe: recipe ? { id: recipe.id, name: recipe.name, description: recipe.description, estimatedSetup: recipe.estimated_setup } : null,
      plan,
      execution: {
        requested: true,
        installs,
        health,
      },
    };
  }

  private resolveRecipe(recipeId?: string, request?: string) {
    if (recipeId) {
      return STACK_RECIPES.find((recipe) => recipe.id === recipeId);
    }
    const normalizedRequest = (request ?? '').toLowerCase().trim();
    if (!normalizedRequest) {
      return null;
    }

    return (
      STACK_RECIPES.find(
        (recipe) =>
          normalizedRequest.includes(recipe.id) ||
          normalizedRequest.includes(recipe.name.toLowerCase()) ||
          recipe.keywords.some((keyword) => normalizedRequest.includes(keyword)),
      ) ?? null
    );
  }

  private async buildPlanFromRecipe(recipe: StackRecipe, includeOptionalApps: boolean): Promise<CompositionPlan> {
    const availableApps = (await this.marketplaceService.getAvailableApps()) ?? [];
    const selectedApps = recipe.apps.filter((app) => includeOptionalApps || app.required);

    const resolvedApps = selectedApps
      .map((app) => {
        const resolvedUrn = this.resolveUrn(
          app.urn,
          availableApps.map((candidate) => candidate.urn),
        );
        if (!resolvedUrn) {
          if (app.required) {
            this.logger.warn(`Required recipe app "${app.urn}" is not available in any configured store`);
          }
          return null;
        }

        return {
          ...app,
          resolvedUrn,
          appId: extractAppUrn(resolvedUrn).appName,
        };
      })
      .filter((app): app is NonNullable<typeof app> => app !== null);

    const envCrossRefs: Record<string, string> = {};
    const appConfigOverrides = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(recipe.shared_config.env_cross_refs)) {
      const [sourceId, envVar] = key.split('.', 2);
      if (!sourceId || !envVar) continue;

      const sourceApp = resolvedApps.find((app) => app.appId === sourceId);
      if (!sourceApp) continue;

      envCrossRefs[`${sourceApp.appId}.${envVar}`] = value;
      appConfigOverrides.set(sourceApp.resolvedUrn, {
        ...(appConfigOverrides.get(sourceApp.resolvedUrn) ?? {}),
        [envVar]: value,
      });
    }

    const appsWithConfig = await Promise.all(
      resolvedApps.map(async (app) => {
        await this.readAppConfig(app.resolvedUrn);
        const overrides = appConfigOverrides.get(app.resolvedUrn);
        return {
          urn: app.resolvedUrn,
          role: app.role,
          required: app.required,
          configOverrides: overrides,
        };
      }),
    );

    return {
      apps: appsWithConfig,
      sharedNetworks: recipe.shared_config.networks,
      sharedVolumes: recipe.shared_config.volumes,
      envCrossRefs,
      resourceEstimate: {
        ramGb: recipe.min_resources.ram_gb,
        diskGb: recipe.min_resources.disk_gb,
      },
    };
  }

  private async buildDynamicPlan(request: string, includeOptionalApps: boolean): Promise<CompositionPlan> {
    const searchResult = await this.marketplaceService.searchApps({ search: request || undefined, pageSize: 6 });
    const matches = searchResult.data.slice(0, includeOptionalApps ? 5 : 1);

    const selected = await Promise.all(
      matches.map(async (app, index) => {
        const compose = await this.marketplaceService.getDockerComposeJson(castAppUrn(app.urn)).catch(() => ({ content: null }));
        const parsedCompose = compose.content ? parseComposeJson(compose.content) : null;
        const mainService = parsedCompose?.services.find((service) => service.isMain) ?? parsedCompose?.services[0];
        const port = mainService?.internalPort ?? app.port ?? 80;

        await this.readAppConfig(app.urn);
        return {
          urn: app.urn,
          appId: extractAppUrn(app.urn).appName,
          role: index === 0 ? 'primary' : 'supporting',
          required: index === 0,
          port,
        };
      }),
    );

    if (selected.length === 0) {
      return {
        apps: [],
        sharedNetworks: [],
        sharedVolumes: {},
        envCrossRefs: {},
        resourceEstimate: { ramGb: 2, diskGb: 10 },
      };
    }

    const primary = selected[0];
    const envCrossRefs: Record<string, string> = {};
    const apps = selected.map((app) => {
      if (app.urn === primary?.urn) {
        return { urn: app.urn, role: app.role, required: app.required };
      }

      const envVar = `${primary?.appId?.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_HOST`;
      const value = `${primary?.appId}:${primary?.port ?? 80}`;
      envCrossRefs[`${app.appId}.${envVar}`] = value;
      return {
        urn: app.urn,
        role: app.role,
        required: app.required,
        configOverrides: { [envVar]: value },
      };
    });

    const sharedVolumes = this.inferSharedVolumes(request);
    return {
      apps,
      sharedNetworks: [`${primary?.appId ?? 'stack'}-net`],
      sharedVolumes,
      envCrossRefs,
      resourceEstimate: {
        ramGb: Math.max(2, Math.ceil(selected.length * 1.5)),
        diskGb: Math.max(10, selected.length * 10),
      },
    };
  }

  private resolveUrn(input: string, availableUrns: string[]) {
    if (input.includes(':')) {
      return availableUrns.includes(input) ? input : null;
    }
    const exact = availableUrns.filter((urn) => extractAppUrn(urn).appName === input);
    if (exact.length === 0) return null;
    return exact.find((urn) => urn.endsWith(':ci-marketplace')) ?? exact[0] ?? null;
  }

  private inferSharedVolumes(request: string) {
    const normalized = request.toLowerCase();
    if (/(media|movie|tv|music)/.test(normalized)) {
      return { media: '/data/media', downloads: '/data/downloads' };
    }
    if (/(ai|llm|model|ollama)/.test(normalized)) {
      return { models: '/data/models' };
    }
    if (/(photo|immich|gallery)/.test(normalized)) {
      return { photos: '/data/photos' };
    }
    return {};
  }

  private async readAppConfig(appUrn: string) {
    await Promise.allSettled([
      this.marketplaceService.getConfigJson(castAppUrn(appUrn)),
      this.marketplaceService.getDockerComposeJson(castAppUrn(appUrn)),
    ]);
  }
}
