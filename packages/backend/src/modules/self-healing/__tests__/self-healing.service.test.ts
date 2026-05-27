import { Test, type TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SelfHealingService } from '../self-healing.service';
import { SelfHealingHistoryService } from '../self-healing-history.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '@/modules/docker/docker.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { AppUrn } from '@ci-hub/common/types';

const APP_URN = 'myapp:store' as AppUrn;

describe('SelfHealingService', () => {
  let service: SelfHealingService;
  let historyService: SelfHealingHistoryService;
  let dockerService: MockProxy<DockerService>;
  let appsRepository: MockProxy<AppsRepository>;
  let agentNotifyService: MockProxy<AgentNotifyService>;
  let inferenceRouter: MockProxy<InferenceRouterService>;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    dockerService = mock<DockerService>();
    appsRepository = mock<AppsRepository>();
    agentNotifyService = mock<AgentNotifyService>();
    inferenceRouter = mock<InferenceRouterService>();
    loggerService = mock<LoggerService>();

    agentNotifyService.notify.mockResolvedValue(undefined);
    dockerService.composeApp.mockResolvedValue(undefined as unknown as ReturnType<DockerService['composeApp']>);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SelfHealingService,
        SelfHealingHistoryService,
        { provide: LoggerService, useValue: loggerService },
        { provide: DockerService, useValue: dockerService },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AgentNotifyService, useValue: agentNotifyService },
        { provide: InferenceRouterService, useValue: inferenceRouter },
      ],
    }).compile();

    service = module.get<SelfHealingService>(SelfHealingService);
    historyService = module.get<SelfHealingHistoryService>(SelfHealingHistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── classifyIssues ──────────────────────────────────────────────────────────

  describe('classifyIssues', () => {
    it('should detect crash-loop from container state', () => {
      const categories = service.classifyIssues('Restarting (1) 5 seconds ago', '');
      expect(categories).toContain('crash-loop');
    });

    it('should detect startup-failure from exited state', () => {
      const categories = service.classifyIssues('Exited (1) 10 seconds ago', '');
      expect(categories).toContain('startup-failure');
    });

    it('should detect port-conflict from logs', () => {
      const categories = service.classifyIssues('Exited (1)', 'Error: bind: address already in use');
      expect(categories).toContain('port-conflict');
    });

    it('should detect oom-killed from logs', () => {
      const categories = service.classifyIssues('Exited (137)', 'Killed\nOut of memory: Kill process');
      expect(categories).toContain('oom-killed');
    });

    it('should detect image-pull-error from logs', () => {
      const categories = service.classifyIssues('Exited (1)', 'pull access denied for myimage, repository does not exist');
      expect(categories).toContain('image-pull-error');
    });

    it('should detect volume-permission from logs', () => {
      const categories = service.classifyIssues('Exited (1)', 'open /data/config.yaml: permission denied');
      expect(categories).toContain('volume-permission');
    });

    it('should detect database-error from logs', () => {
      const categories = service.classifyIssues('Exited (1)', 'Error: connection refused: could not connect to server');
      expect(categories).toContain('database-error');
    });

    it('should return unknown when no pattern matches', () => {
      const categories = service.classifyIssues('Exited (0)', 'some unrecognized log line');
      expect(categories).toContain('unknown');
    });

    it('should detect multiple categories from a single log', () => {
      const categories = service.classifyIssues('Restarting (1)', 'Out of memory AND connection refused to database');
      expect(categories).toContain('crash-loop');
      expect(categories).toContain('oom-killed');
      expect(categories).toContain('database-error');
    });
  });

  // ─── decideResolution ────────────────────────────────────────────────────────

  describe('decideResolution', () => {
    it('should decide restart for a transient startup-failure with no history', () => {
      const resolution = service.decideResolution(APP_URN, 'c1', ['startup-failure']);
      expect(resolution.action).toBe('restart');
    });

    it('should decide restart for crash-loop with no history', () => {
      const resolution = service.decideResolution(APP_URN, 'c1', ['crash-loop']);
      expect(resolution.action).toBe('restart');
    });

    it('should decide notify for port-conflict (always manual)', () => {
      const resolution = service.decideResolution(APP_URN, 'c1', ['port-conflict']);
      expect(resolution.action).toBe('notify');
    });

    it('should decide notify for image-pull-error (always manual)', () => {
      const resolution = service.decideResolution(APP_URN, 'c1', ['image-pull-error']);
      expect(resolution.action).toBe('notify');
    });

    it('should decide notify for config-error (always manual)', () => {
      const resolution = service.decideResolution(APP_URN, 'c1', ['config-error']);
      expect(resolution.action).toBe('notify');
    });

    it('should decide notify when restart budget exhausted (3+ restarts in 1 hour)', () => {
      // Add 3 restart incidents within the last hour
      for (let i = 0; i < 3; i++) {
        historyService.addIncident({
          appUrn: APP_URN,
          containerName: 'c1',
          categories: ['crash-loop'],
          logsExcerpt: '',
          action: 'restarted',
          outcome: 'resolved',
        });
      }

      const resolution = service.decideResolution(APP_URN, 'c1', ['crash-loop']);
      expect(resolution.action).toBe('notify');
    });

    it('should still allow restart when under the budget (2 restarts in 1 hour)', () => {
      for (let i = 0; i < 2; i++) {
        historyService.addIncident({
          appUrn: APP_URN,
          containerName: 'c1',
          categories: ['crash-loop'],
          logsExcerpt: '',
          action: 'restarted',
          outcome: 'resolved',
        });
      }

      const resolution = service.decideResolution(APP_URN, 'c1', ['crash-loop']);
      expect(resolution.action).toBe('restart');
    });
  });

  // ─── runMonitorCycle ─────────────────────────────────────────────────────────

  describe('runMonitorCycle', () => {
    it('should not attempt to heal apps with no unhealthy containers', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'myapp', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers.mockResolvedValue({ unhealthy: [], healthy: ['myapp-container'] });

      await service.runMonitorCycle();

      expect(dockerService.composeApp).not.toHaveBeenCalled();
      expect(agentNotifyService.notify).not.toHaveBeenCalled();
    });

    it('should restart a container with startup-failure', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'myapp', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers.mockResolvedValue({
        unhealthy: [{ name: 'myapp-container', state: 'Exited (1)', logs: 'some error' }],
        healthy: [],
      });

      await service.runMonitorCycle();

      expect(dockerService.composeApp).toHaveBeenCalledWith(APP_URN, 'up --detach --force-recreate --remove-orphans');
      expect(agentNotifyService.notify).toHaveBeenCalledWith('self_healing.auto_restarted', expect.any(Object), 'info');
    });

    it('should notify user for port-conflict (no auto-restart)', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'myapp', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers.mockResolvedValue({
        unhealthy: [{ name: 'myapp-container', state: 'Exited (1)', logs: 'bind: address already in use' }],
        healthy: [],
      });

      inferenceRouter.routeChatCompletion.mockRejectedValue(new Error('no model'));

      await service.runMonitorCycle();

      expect(dockerService.composeApp).not.toHaveBeenCalled();
      expect(agentNotifyService.notify).toHaveBeenCalledWith('self_healing.needs_attention', expect.any(Object), 'high');
    });

    it('should record incidents in history during the monitor cycle', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'myapp', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers.mockResolvedValue({
        unhealthy: [{ name: 'myapp-container', state: 'Exited (1)', logs: 'error' }],
        healthy: [],
      });

      await service.runMonitorCycle();

      const history = historyService.getRecentIncidents(APP_URN);
      expect(history).toHaveLength(1);
    });

    it('should escalate to user notification when restart fails', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'myapp', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers.mockResolvedValue({
        unhealthy: [{ name: 'myapp-container', state: 'Exited (1)', logs: 'error' }],
        healthy: [],
      });

      dockerService.composeApp.mockRejectedValueOnce(new Error('compose failed'));
      inferenceRouter.routeChatCompletion.mockRejectedValue(new Error('no model'));

      await service.runMonitorCycle();

      expect(agentNotifyService.notify).toHaveBeenCalledWith('self_healing.needs_attention', expect.any(Object), 'high');
    });

    it('should continue healing other apps when one throws', async () => {
      appsRepository.getAppsByStatus.mockResolvedValue([
        { appName: 'app1', appStoreSlug: 'store', id: 1 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
        { appName: 'app2', appStoreSlug: 'store', id: 2 } as ReturnType<AppsRepository['getAppsByStatus']> extends Promise<infer T>
          ? T[number]
          : never,
      ]);

      dockerService.diagnoseAppContainers
        .mockRejectedValueOnce(new Error('docker error'))
        .mockResolvedValueOnce({ unhealthy: [], healthy: ['app2-container'] });

      await service.runMonitorCycle();

      // Should have called diagnose for both apps
      expect(dockerService.diagnoseAppContainers).toHaveBeenCalledTimes(2);
    });
  });

  // ─── diagnoseWithAI ──────────────────────────────────────────────────────────

  describe('diagnoseWithAI', () => {
    it('should return null when no inferenceRouter is available', async () => {
      // Create service without inference router
      const moduleWithoutAI: TestingModule = await Test.createTestingModule({
        providers: [
          SelfHealingService,
          SelfHealingHistoryService,
          { provide: LoggerService, useValue: loggerService },
          { provide: DockerService, useValue: dockerService },
          { provide: AppsRepository, useValue: appsRepository },
        ],
      }).compile();

      const serviceWithoutAI = moduleWithoutAI.get<SelfHealingService>(SelfHealingService);
      const result = await serviceWithoutAI.diagnoseWithAI(APP_URN, 'some logs', ['crash-loop']);
      expect(result).toBeNull();
    });

    it('should return AI diagnosis when inference succeeds', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue({
        data: {
          choices: [{ message: { content: '{"diagnosis": "The app crashed due to OOM.", "suggestions": ["Increase memory"]}' } }],
        },
        backend: 'ollama',
      });

      const result = await service.diagnoseWithAI(APP_URN, 'Killed\nOOM', ['oom-killed']);

      expect(result).not.toBeNull();
      expect(result?.diagnosis).toBe('The app crashed due to OOM.');
      expect(result?.suggestions).toEqual(['Increase memory']);
    });

    it('should return null when inference throws', async () => {
      inferenceRouter.routeChatCompletion.mockRejectedValue(new Error('backend unavailable'));

      const result = await service.diagnoseWithAI(APP_URN, 'some logs', ['crash-loop']);
      expect(result).toBeNull();
    });

    it('should return null when AI response has no diagnosis field', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue({
        data: {
          choices: [{ message: { content: '{"suggestions": ["do something"]}' } }],
        },
        backend: 'ollama',
      });

      const result = await service.diagnoseWithAI(APP_URN, 'some logs', ['unknown']);
      expect(result).toBeNull();
    });

    it('should not call inferenceRouter when logs and categories are provided (smoke test)', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: '{"diagnosis": "test", "suggestions": []}' } }] },
        backend: 'ollama',
      });

      await service.diagnoseWithAI(APP_URN, 'log output', ['crash-loop']);

      expect(inferenceRouter.routeChatCompletion).toHaveBeenCalledOnce();

      const callArgs = vi.mocked(inferenceRouter.routeChatCompletion).mock.calls[0]?.[0] as { messages?: Array<{ content?: string }> };
      expect(callArgs.messages?.[0]?.content).toContain(APP_URN);
      expect(callArgs.messages?.[0]?.content).toContain('crash-loop');
    });
  });
});
