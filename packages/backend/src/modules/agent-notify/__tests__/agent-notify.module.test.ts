import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AgentNotifyService } from '../agent-notify.service';
import { AgentHealthCheckService } from '../agent-health-check.service';
import { SystemService } from '@/modules/system/system.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('AgentNotifyModule', () => {
  it('should compile as a standalone NestJS module', async () => {
    const module = await Test.createTestingModule({
      providers: [
        AgentNotifyService,
        AgentHealthCheckService,
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    expect(module).toBeDefined();
  });

  it('should export AgentNotifyService for use by other modules', async () => {
    const module = await Test.createTestingModule({
      providers: [
        AgentNotifyService,
        AgentHealthCheckService,
        { provide: SystemService, useValue: mock<SystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
      exports: [AgentNotifyService],
    }).compile();
    expect(module.get(AgentNotifyService)).toBeDefined();
  });
});
