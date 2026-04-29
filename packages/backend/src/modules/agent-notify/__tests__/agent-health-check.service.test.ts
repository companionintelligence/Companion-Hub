import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentHealthCheckService } from '../agent-health-check.service';
import { AgentNotifyService } from '../agent-notify.service';

describe('AgentHealthCheckService', () => {
  let service: AgentHealthCheckService;
  let notifyService: MockProxy<AgentNotifyService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentHealthCheckService, { provide: AgentNotifyService, useValue: mock<AgentNotifyService>() }],
    }).compile();

    service = module.get<AgentHealthCheckService>(AgentHealthCheckService);
    notifyService = module.get(AgentNotifyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // --- AN-3: periodic system health checks ---

  describe('periodic health checks', () => {
    // S-AN-3.1: checks disk usage, emits system.high_disk when > 90%
    it.todo('should emit system.high_disk when disk percentUsed > 90');
    it.todo('should emit system.high_disk with urgency high');
    it.todo('should not emit system.high_disk when disk percentUsed <= 90');

    // S-AN-3.2: emits system.high_memory when > 90%
    it.todo('should emit system.high_memory when percentUsedMemory > 90');
    it.todo('should emit system.high_memory with urgency medium');
    it.todo('should not emit system.high_memory when percentUsedMemory <= 90');

    // S-AN-3.3: debounces health events — same event not re-emitted within 1 hour
    it.todo('should not re-emit same health event within 1 hour');
    it.todo('should re-emit health event after 1 hour has passed');
    it.todo('should debounce system.high_disk and system.high_memory independently');
  });

  describe('configuration', () => {
    // AGENT_HEALTH_CHECK_INTERVAL_MINUTES (default: 15)
    it.todo('should default check interval to 15 minutes');
    it.todo('should respect custom AGENT_HEALTH_CHECK_INTERVAL_MINUTES');
  });
});
