import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentNotifyService } from '../agent-notify.service';
import { ConfigurationService } from '@/core/config/configuration.service';

describe('AgentNotifyService', () => {
  let service: AgentNotifyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentNotifyService],
    }).compile();

    service = module.get<AgentNotifyService>(AgentNotifyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // --- AN-1: notify method ---

  describe('notify', () => {
    // S-AN-1.1: exposes notify(event, data, urgency)
    it.todo('should accept event string, data object, and urgency parameter');

    // S-AN-1.2: POSTs JSON payload to AGENT_WEBHOOK_URL with { event, data, urgency, timestamp }
    it.todo('should POST to configured webhook URL with correct payload structure');
    it.todo('should include ISO-8601 timestamp in payload');
    it.todo('should include event name in payload');
    it.todo('should include data object in payload');
    it.todo('should include urgency level in payload');

    // S-AN-1.3: includes Authorization: Bearer <AGENT_WEBHOOK_TOKEN> header
    it.todo('should include Authorization Bearer token header');

    // S-AN-1.4: no-op when AGENT_WEBHOOK_URL not set or AGENT_WEBHOOK_ENABLED=false
    it.todo('should be a no-op when AGENT_WEBHOOK_URL is not set');
    it.todo('should be a no-op when AGENT_WEBHOOK_ENABLED is false');
    it.todo('should not throw when disabled');

    // S-AN-1.5: fire-and-forget — logs error on failure, does not throw
    it.todo('should log error when webhook POST fails with network error');
    it.todo('should log error when webhook POST returns non-2xx status');
    it.todo('should not throw when webhook POST fails');

    // S-AN-1.6: debounces identical events (same event + appUrn) within 30s
    it.todo('should debounce identical events within 30-second window');
    it.todo('should send event again after 30-second window expires');
    it.todo('should not debounce events with different appUrn');
    it.todo('should not debounce events with different event names');
  });

  // --- AN-2: wiring into existing services ---

  describe('event wiring', () => {
    // S-AN-2.1: AppLifecycleService emits on errors and success
    describe('AppLifecycleService events', () => {
      it.todo('should notify on install_error with urgency high');
      it.todo('should notify on uninstall_error with urgency high');
      it.todo('should notify on update_error with urgency high');
      it.todo('should notify on start_error with urgency high');
      it.todo('should notify on stop_error with urgency high');
      it.todo('should notify on reset_error with urgency high');
      it.todo('should notify on restart_error with urgency high');
      it.todo('should notify on update_success with urgency info');
      it.todo('should notify on backup_error with urgency high');
      it.todo('should notify on restore_error with urgency high');
    });

    // S-AN-2.2: AppStatusSyncService emits app.crashed on running → stopped/missing
    describe('AppStatusSyncService events', () => {
      it.todo('should notify app.crashed when app transitions from running to stopped');
      it.todo('should notify app.crashed when app transitions from running to missing');
      it.todo('should not notify when app transitions from stopped to stopped');
      it.todo('should emit with urgency high');
    });

    // S-AN-2.3: SystemUpdateService emits system.update_available
    describe('SystemUpdateService events', () => {
      it.todo('should notify system.update_available when update is available');
      it.todo('should emit with urgency low');
    });

    // S-AN-2.4: RegistrationService emits registration.state_changed
    describe('RegistrationService events', () => {
      it.todo('should notify registration.state_changed on provisioning phase changes');
      it.todo('should emit with urgency medium');
      it.todo('should include oldPhase and newPhase in data');
    });

    // S-AN-2.5: MCP module startup emits system.mcp_ready
    describe('MCP module startup', () => {
      it.todo('should notify system.mcp_ready on MCP module startup');
      it.todo('should emit with urgency info');
    });
  });
});
