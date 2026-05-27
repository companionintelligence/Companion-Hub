import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { SourcePlatform } from '@ci-hub/common/types';

const PLATFORM_CONTEXT: Record<SourcePlatform, { dataDir: string; configFormat: string; notes: string }> = {
  umbrel: {
    dataDir: '~/umbrel/app-data/<app>/',
    configFormat: 'docker-compose.yml + app.yml',
    notes: 'Uses Tor by default. App data lives under ~/umbrel/app-data/<app>/data/.',
  },
  casaos: {
    dataDir: '/DATA/AppData/',
    configFormat: 'Docker Compose via CasaOS API',
    notes: 'Typically uses LinuxServer.io images. Config stored in /DATA/AppData/<app>/.',
  },
  synology: {
    dataDir: '/volume1/docker/',
    configFormat: 'Container Manager UI export (JSON or YAML)',
    notes: 'DSM-specific networking (synobridge). Data stored under /volume1/docker/<app>/.',
  },
  unraid: {
    dataDir: '/mnt/user/appdata/',
    configFormat: 'XML Community Applications template',
    notes: 'Custom network modes (br0, macvlan). App data under /mnt/user/appdata/<app>/.',
  },
  docker: {
    dataDir: 'varies (bind-mount paths in compose file)',
    configFormat: 'docker-compose.yml',
    notes: 'Standard Docker Compose; paths and volumes vary per deployment.',
  },
  runtipi: {
    dataDir: '~/runtipi/app-data/',
    configFormat: 'docker-compose.json + app.json (Runtipi format)',
    notes: 'Nearly 1:1 mapping with CI-Hub. App data under ~/runtipi/app-data/<app>/data/.',
  },
};

const IMPORT_SYSTEM_PROMPT = `You are a DevOps expert specialising in Docker-based self-hosting platforms.
Your task is to generate a self-contained bash migration script that moves a user's setup from a source platform into CI-Hub.

Rules:
1. The script MUST NOT execute the migration automatically — it should be reviewed by the user first.
2. Always back up ALL data BEFORE modifying anything. No exceptions.
3. Stop source containers gracefully before copying data.
4. Map volumes to CI-Hub's expected paths (/app/data/<appId>/).
5. Include database dump + restore steps where needed (PostgreSQL, MySQL, SQLite).
6. Translate environment variables to CI-Hub .env format.
7. Include verification steps at the end ("check that the app is healthy").
8. Include a ROLLBACK section at the bottom that undoes every change.
9. Write clear comments explaining each step.
10. Output ONLY the bash script — no markdown, no explanations outside the script.

CI-Hub conventions:
- App data: /app/data/<appId>/
- docker compose project name: ci-<appId>
- CI-Hub is installed at /app/ and managed via CI-Hub CLI (ci app install <appId>)

The script must be idempotent wherever possible.`;

const EXPORT_SYSTEM_PROMPT = `You are a DevOps expert specialising in Docker-based self-hosting platforms.
Your task is to generate two artefacts for a CI-Hub user who wants a portable, standalone export of their running setup:

1. A complete docker-compose.yml that:
   - Works independently of CI-Hub (no Traefik labels, no CI-Hub networking)
   - Includes all services, volumes, networks and environment variables
   - Documents what each service does and how they connect
   - Can be deployed on any plain Docker host

2. A self-contained bash backup/restore script that:
   - Backs up all named volumes and bind-mount paths
   - Creates a timestamped tar archive
   - Includes a RESTORE section at the bottom

Output format — return ONLY this JSON (no markdown fences):
{
  "composefile": "<full docker-compose.yml content>",
  "script": "<full bash backup/restore script content>",
  "warnings": ["<optional warning 1>", "..."]
}`;

@Injectable()
export class MigrationService {
  constructor(
    private readonly logger: LoggerService,
    private readonly inferenceRouter: InferenceRouterService,
  ) {}

  async generateImportScript(platform: SourcePlatform, description: string): Promise<{ script: string; warnings: string[] }> {
    const ctx = PLATFORM_CONTEXT[platform];

    const userMessage = `Source platform: ${platform}
Platform data directory: ${ctx.dataDir}
Platform config format: ${ctx.configFormat}
Platform notes: ${ctx.notes}

User's setup description / provided config files:
${description}

Generate the migration script now.`;

    this.logger.info(`[Migration] Generating import script from ${platform}`);

    const result = await this.inferenceRouter.routeChatCompletion({
      model: 'auto',
      stream: false,
      messages: [
        { role: 'system', content: IMPORT_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const data = result.data as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content ?? '';

    const warnings = this.extractWarnings(content);
    const script = content.trim();

    return { script, warnings };
  }

  async generateExportScript(installedAppsDescription: string): Promise<{ script: string; composefile: string; warnings: string[] }> {
    const userMessage = `Here is the description of the currently installed CI-Hub apps and their configuration:

${installedAppsDescription}

Generate the portable docker-compose.yml and backup/restore script now.`;

    this.logger.info('[Migration] Generating export script');

    const result = await this.inferenceRouter.routeChatCompletion({
      model: 'auto',
      stream: false,
      messages: [
        { role: 'system', content: EXPORT_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const data = result.data as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data?.choices?.[0]?.message?.content ?? '{}';

    try {
      const parsed = JSON.parse(rawContent) as {
        composefile?: string;
        script?: string;
        warnings?: string[];
      };
      return {
        composefile: parsed.composefile ?? '',
        script: parsed.script ?? '',
        warnings: parsed.warnings ?? [],
      };
    } catch {
      this.logger.warn('[Migration] Could not parse export response as JSON — returning raw');
      return { composefile: '', script: rawContent, warnings: [] };
    }
  }

  private extractWarnings(script: string): string[] {
    const warnings: string[] = [];
    const lines = script.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# WARNING:') || trimmed.startsWith('# WARN:') || trimmed.startsWith('# NOTE:')) {
        warnings.push(trimmed.replace(/^#\s*(WARNING|WARN|NOTE):\s*/, ''));
      }
    }
    return warnings;
  }
}
