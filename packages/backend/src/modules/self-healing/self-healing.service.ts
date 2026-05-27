import { Injectable, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { AppUrn } from '@ci-hub/common/types';
import { SelfHealingHistoryService, type IssueCategory, type HealingAction } from './self-healing-history.service';

/**
 * Autonomous resolution decision.
 * `restart` – safe, reversible action the agent will execute without user input.
 * `notify`  – issue requires human review; agent explains and suggests next steps.
 */
type Resolution = { action: 'restart' } | { action: 'notify'; reason: string; suggestions: string[] };

/** Pattern → IssueCategory mapping for log-based heuristics */
const LOG_PATTERNS: Array<{ pattern: RegExp; category: IssueCategory }> = [
  { pattern: /address already in use|port is already allocated|bind.*address/i, category: 'port-conflict' },
  { pattern: /killed|out of memory|cannot allocate memory|oom/i, category: 'oom-killed' },
  { pattern: /pull access denied|manifest unknown|not found.*image|image pull failed|no such image/i, category: 'image-pull-error' },
  { pattern: /permission denied|eacces|cannot open|no such file.*permission/i, category: 'volume-permission' },
  {
    pattern: /connection refused|econnrefused|no route to host|database.*error|failed to connect.*db|could not connect to server/i,
    category: 'database-error',
  },
  { pattern: /environment variable|required.*variable|missing.*env|undefined.*env|configuration.*error/i, category: 'config-error' },
  { pattern: /service.*unhealthy|depends_on|health check failed|dependency.*fail/i, category: 'dependency-failure' },
];

/** Maximum autonomous restarts per app per hour before escalating to user */
const MAX_AUTO_RESTARTS_PER_HOUR = 3;

@Injectable()
export class SelfHealingService implements OnApplicationBootstrap, OnModuleDestroy {
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly dockerService: DockerService,
    private readonly appsRepository: AppsRepository,
    private readonly historyService: SelfHealingHistoryService,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
    @Optional() private readonly inferenceRouter?: InferenceRouterService,
  ) {}

  onApplicationBootstrap() {
    const intervalMinutes = Number(process.env.SELF_HEALING_INTERVAL_MINUTES) || 5;
    this.monitorInterval = setInterval(
      () => {
        this.runMonitorCycle().catch((err) => {
          this.logger.error(`[SelfHealing] Monitor cycle error: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      intervalMinutes * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
  }

  /**
   * Execute one monitoring cycle: inspect all running apps, diagnose unhealthy
   * containers, and attempt autonomous or assisted healing.
   */
  async runMonitorCycle(): Promise<void> {
    this.logger.debug('[SelfHealing] Starting monitor cycle');

    const runningApps = await this.appsRepository.getAppsByStatus('running');

    for (const dbApp of runningApps) {
      const appUrn = `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn;
      try {
        await this.healApp(appUrn);
      } catch (err) {
        this.logger.error(`[SelfHealing] Error healing ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.debug('[SelfHealing] Monitor cycle complete');
  }

  /**
   * Inspect containers for a single app and apply healing if needed.
   * Public so it can be triggered on-demand (e.g. from AppStatusSyncService).
   */
  async healApp(appUrn: AppUrn): Promise<void> {
    const diagnosis = await this.dockerService.diagnoseAppContainers(appUrn);

    if (diagnosis.unhealthy.length === 0) {
      return;
    }

    for (const container of diagnosis.unhealthy) {
      const categories = this.classifyIssues(container.state, container.logs);
      const resolution = this.decideResolution(appUrn, container.name, categories);

      this.logger.warn(
        `[SelfHealing] ${appUrn} / ${container.name}: ${container.state} | categories: [${categories.join(', ')}] | action: ${resolution.action}`,
      );

      let action: HealingAction;
      let incidentId: string;

      if (resolution.action === 'restart') {
        action = 'restarted';
        const incident = this.historyService.addIncident({
          appUrn,
          containerName: container.name,
          categories,
          logsExcerpt: container.logs.slice(0, 500),
          action,
          outcome: 'pending',
        });
        incidentId = incident.id;

        try {
          await this.dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
          this.historyService.updateOutcome(incidentId, 'resolved');
          this.logger.info(`[SelfHealing] Autonomously restarted ${appUrn}`);

          await this.agentNotifyService?.notify('self_healing.auto_restarted', { appUrn, containerName: container.name, categories }, 'info');
        } catch (restartErr) {
          this.historyService.updateOutcome(incidentId, 'failed');
          this.logger.error(
            `[SelfHealing] Auto-restart of ${appUrn} failed: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
          );

          // Escalate to user notification after failed restart
          const aiDiagnosis = await this.diagnoseWithAI(appUrn, container.logs, categories);
          const primaryCategory = categories[0] ?? 'unknown';
          await this.notifyUser(
            appUrn,
            container,
            categories,
            aiDiagnosis ?? {
              diagnosis: this.humanReadableReason(primaryCategory),
              suggestions: this.defaultSuggestions(primaryCategory),
            },
          );
        }
      } else {
        // resolution.action === 'notify'
        const aiDiagnosis = await this.diagnoseWithAI(appUrn, container.logs, categories);
        const diagnosisText = aiDiagnosis?.diagnosis ?? resolution.reason;
        const suggestions = aiDiagnosis?.suggestions ?? resolution.suggestions;

        action = aiDiagnosis ? 'ai-diagnosed' : 'notified-user';

        const incident = this.historyService.addIncident({
          appUrn,
          containerName: container.name,
          categories,
          logsExcerpt: container.logs.slice(0, 500),
          action,
          outcome: 'pending',
          diagnosis: diagnosisText,
        });
        incidentId = incident.id;

        await this.notifyUser(appUrn, container, categories, { diagnosis: diagnosisText, suggestions });
        this.historyService.updateOutcome(incidentId, 'unknown');
      }
    }
  }

  /**
   * Classify a container's failure by inspecting its Docker state string and
   * recent log output.  Returns an array of detected categories (may be empty if
   * no pattern matches, in which case the caller should treat it as 'unknown').
   */
  classifyIssues(containerState: string, logs: string): IssueCategory[] {
    const categories = new Set<IssueCategory>();

    if (containerState.toLowerCase().includes('restarting')) {
      categories.add('crash-loop');
    } else if (/exited \([1-9][0-9]*\)|dead/i.test(containerState)) {
      // Only flag as startup-failure for non-zero exits; Exited (0) is a clean stop
      categories.add('startup-failure');
    }

    for (const { pattern, category } of LOG_PATTERNS) {
      if (pattern.test(logs)) {
        categories.add(category);
      }
    }

    if (categories.size === 0) {
      categories.add('unknown');
    }

    return Array.from(categories);
  }

  /**
   * Decide whether to autonomously restart or escalate to the user.
   *
   * Rules:
   * 1. Issues that are never safe to auto-fix → always notify.
   * 2. If we have already restarted this app 3+ times in the past hour → notify.
   * 3. Otherwise → restart.
   */
  decideResolution(appUrn: AppUrn, _containerName: string, categories: IssueCategory[]): Resolution {
    // Issues that require user intervention regardless of history
    const manualCategories: IssueCategory[] = ['port-conflict', 'image-pull-error', 'config-error', 'volume-permission'];
    const requiresManual = categories.some((c) => manualCategories.includes(c));

    if (requiresManual) {
      const primaryCategory = categories.find((c) => manualCategories.includes(c)) ?? categories[0] ?? 'unknown';
      return {
        action: 'notify',
        reason: this.humanReadableReason(primaryCategory),
        suggestions: this.defaultSuggestions(primaryCategory),
      };
    }

    // Check restart budget
    const restartsThisHour = this.historyService.countRestarts(appUrn);
    if (restartsThisHour >= MAX_AUTO_RESTARTS_PER_HOUR) {
      return {
        action: 'notify',
        reason: `The app has been restarted ${restartsThisHour} times in the past hour and is still unhealthy.`,
        suggestions: ['Check the container logs for a persistent error', 'Review app configuration', 'Consider rolling back to a previous version'],
      };
    }

    return { action: 'restart' };
  }

  /**
   * Call the local/cloud inference service to produce a human-readable
   * diagnosis and suggested remediation steps.  Returns null when no inference
   * backend is available so callers can fall back to heuristic messages.
   */
  async diagnoseWithAI(appUrn: AppUrn, logs: string, categories: IssueCategory[]): Promise<{ diagnosis: string; suggestions: string[] } | null> {
    if (!this.inferenceRouter) {
      return null;
    }

    const recentHistory = this.historyService.getRecentIncidents(appUrn).slice(-5);

    const prompt = `You are a self-hosted Docker infrastructure expert embedded in CI-Hub, an AI-first home-server platform.

An app failed and needs diagnosis. Respond with a concise, actionable JSON object.

## App URN
${appUrn}

## Container Failure Categories
${categories.join(', ')}

## Container Logs (last 500 chars)
${logs.slice(0, 500)}

## Recent Incident History (last 5)
${JSON.stringify(recentHistory, null, 2)}

Respond ONLY with valid JSON in this exact format:
{
  "diagnosis": "One paragraph explaining the root cause in plain English.",
  "suggestions": ["Action 1", "Action 2", "Action 3"]
}

Keep suggestions short, specific, and actionable. Max 3 suggestions.`;

    try {
      const result = await this.inferenceRouter.routeChatCompletion({
        model: 'auto',
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      });

      // result.data is an OpenAI-compatible response object
      const data = result.data as { choices?: Array<{ message?: { content?: string } }> };
      const content = data?.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as { diagnosis?: string; suggestions?: string[] };
      if (!parsed.diagnosis) return null;

      return {
        diagnosis: parsed.diagnosis,
        suggestions: parsed.suggestions ?? [],
      };
    } catch (err) {
      this.logger.debug(`[SelfHealing] AI diagnosis failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Send a user-facing notification with diagnosis and remediation suggestions */
  private async notifyUser(
    appUrn: AppUrn,
    container: { name: string; state: string; logs: string },
    categories: IssueCategory[],
    details: { diagnosis: string; suggestions: string[] },
  ): Promise<void> {
    await this.agentNotifyService?.notify(
      'self_healing.needs_attention',
      {
        appUrn,
        containerName: container.name,
        containerState: container.state,
        categories,
        diagnosis: details.diagnosis,
        suggestions: details.suggestions,
      },
      'high',
    );
  }

  /** Build a plain-English description for a known category */
  private humanReadableReason(category: IssueCategory): string {
    switch (category) {
      case 'port-conflict':
        return 'A required port is already in use by another process or container.';
      case 'image-pull-error':
        return 'The container image could not be pulled. It may not exist, require authentication, or specify an unsupported architecture.';
      case 'config-error':
        return 'One or more required environment variables or configuration values are missing or invalid.';
      case 'volume-permission':
        return 'The container cannot access a mounted volume due to filesystem permission errors.';
      case 'oom-killed':
        return 'The container was killed because it exceeded its memory limit.';
      case 'database-error':
        return 'The app cannot connect to its database. The database may not be running or has exhausted its connection pool.';
      case 'dependency-failure':
        return 'A dependency service is unhealthy, preventing this container from starting.';
      case 'crash-loop':
        return 'The container is in a crash loop — it keeps restarting and failing.';
      case 'startup-failure':
        return 'The container failed to start successfully.';
      default:
        return 'The container failed for an unknown reason. Check the logs for details.';
    }
  }

  /** Default remediation suggestions for known categories */
  private defaultSuggestions(category: IssueCategory): string[] {
    switch (category) {
      case 'port-conflict':
        return ['Change the app port in its settings', 'Stop the conflicting process or container', 'Check which app is using the same port'];
      case 'image-pull-error':
        return ['Verify the image name and tag are correct', 'Check your internet connectivity', 'Try pulling the image manually with `docker pull`'];
      case 'config-error':
        return ['Review the app configuration and fill in missing values', 'Check the app documentation for required environment variables'];
      case 'volume-permission':
        return ['Fix volume ownership with `chown -R 1000:1000 <data-dir>`', 'Check the app documentation for required uid/gid'];
      case 'oom-killed':
        return ['Increase the memory available to Docker', 'Reduce memory usage of other running apps', 'Check for memory leaks in this app'];
      case 'database-error':
        return ['Ensure the database container is running', 'Check database credentials in the app configuration', 'Restart the database service'];
      case 'dependency-failure':
        return ['Check the health of dependency services', 'Restart dependency services first, then restart this app'];
      case 'crash-loop':
        return ['Check the container logs for the actual error', 'Review app configuration', 'Try a fresh install'];
      default:
        return ['Check `docker logs` for this container', 'Review the app configuration'];
    }
  }

  /** Exposed for testing */
  _setMonitorInterval(ms: number): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    this.monitorInterval = setInterval(() => {
      this.runMonitorCycle().catch((_err) => {
        // errors are already logged inside runMonitorCycle
      });
    }, ms);
  }
}
