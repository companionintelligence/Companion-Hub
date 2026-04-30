import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentNotifyService } from '../agent-notify.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('AgentNotifyService', () => {
  let service: AgentNotifyService;
  let logger: MockProxy<LoggerService>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.AGENT_WEBHOOK_URL = 'http://localhost:18789/hooks/hub-wake';
    process.env.AGENT_WEBHOOK_TOKEN = 'test-token';
    process.env.AGENT_WEBHOOK_ENABLED = 'true';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentNotifyService, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();

    service = module.get<AgentNotifyService>(AgentNotifyService);
    logger = module.get(LoggerService);
  });

  afterEach(() => {
    process.env.AGENT_WEBHOOK_URL = originalEnv.AGENT_WEBHOOK_URL;
    process.env.AGENT_WEBHOOK_TOKEN = originalEnv.AGENT_WEBHOOK_TOKEN;
    process.env.AGENT_WEBHOOK_ENABLED = originalEnv.AGENT_WEBHOOK_ENABLED;
    vi.restoreAllMocks();
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('notify', () => {
    it('should POST to configured webhook URL with correct payload structure', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.objectContaining({ method: 'POST' }));
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call?.[1]?.body as string);
      expect(body.event).toBe('app.crashed');
      expect(body.data).toEqual({ appUrn: 'ci-store:test' });
      expect(body.urgency).toBe('high');
      expect(body.timestamp).toBeDefined();
    });

    it('should include ISO-8601 timestamp in payload', async () => {
      await service.notify('test.event', {}, 'info');
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(call?.[1]?.body as string);
      expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
    });

    it('should include Authorization Bearer token header', async () => {
      await service.notify('test.event', {}, 'info');
      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
    });

    it('should be a no-op when no targets and AGENT_WEBHOOK_URL is not set', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      await service.notify('test', {}, 'info');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should be a no-op when AGENT_WEBHOOK_ENABLED is false', async () => {
      process.env.AGENT_WEBHOOK_ENABLED = 'false';
      await service.notify('test', {}, 'info');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should not throw when disabled', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      await expect(service.notify('test', {}, 'info')).resolves.toBeUndefined();
    });

    it('should log error when webhook POST fails with network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
      await service.notify('test', {}, 'info');
      expect(logger.error).toHaveBeenCalled();
    });

    it('should log error when webhook POST returns non-2xx status', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('Server Error', { status: 500 }));
      await service.notify('test', {}, 'info');
      expect(logger.error).toHaveBeenCalled();
    });

    it('should not throw when webhook POST fails', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));
      await expect(service.notify('test', {}, 'info')).resolves.toBeUndefined();
    });

    it('should debounce identical events within 30-second window', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should not debounce events with different appUrn', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:app1' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:app2' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should not debounce events with different event names', async () => {
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.update_failed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should send event again after debounce window expires', async () => {
      service._setDebounceWindowMs(0);
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('R-MW: Multi-webhook registry', () => {
    it('R-MW-2: should register a webhook for an app', () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret-1');

      const webhooks = service.getRegisteredWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]).toEqual({
        url: 'http://openclaw-ci-store:3000/hooks/hub-wake',
        token: 'secret-1',
        appUrn: 'ci-store:openclaw',
      });
    });

    it('R-MW-2: should unregister a webhook', () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret-1');
      const removed = service.unregisterWebhook('ci-store:openclaw');

      expect(removed).toBe(true);
      expect(service.getRegisteredWebhooks()).toHaveLength(0);
    });

    it('R-MW-2: unregisterWebhook returns false for unknown app', () => {
      const removed = service.unregisterWebhook('ci-store:nonexistent');
      expect(removed).toBe(false);
    });

    it('R-MW-3: should fan-out to env webhook AND registered webhook', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'oc-secret');

      await service.notify('app.crashed', { appUrn: 'ci-store:test' }, 'high');

      // Should call both env webhook and registered webhook
      expect(fetch).toHaveBeenCalledTimes(2);

      const urls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
      expect(urls).toContain('http://localhost:18789/hooks/hub-wake');
      expect(urls).toContain('http://openclaw-ci-store:3000/hooks/hub-wake');
    });

    it('R-MW-3: registered webhook uses its own token', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'oc-secret');

      await service.notify('test.event', {}, 'info');

      const calls = vi.mocked(fetch).mock.calls;
      const registeredCall = calls.find((c) => (c[0] as string).includes('openclaw'));
      const headers = registeredCall?.[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer oc-secret');
    });

    it('R-MW-4: should use env webhook as fallback when no registered webhooks', async () => {
      await service.notify('test', {}, 'info');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('http://localhost:18789/hooks/hub-wake', expect.anything());
    });

    it('R-MW-4: env webhook and registered webhooks coexist', async () => {
      service.registerWebhook('ci-store:hermes', 'http://hermes-ci-store:8080/wake', 'h-secret');

      await service.notify('test', {}, 'info');

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('R-MW-3: should notify via registered webhooks when no env webhook', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      service.registerWebhook('ci-store:openclaw', 'http://openclaw-ci-store:3000/hooks/hub-wake', 'secret');

      await service.notify('test', {}, 'info');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith('http://openclaw-ci-store:3000/hooks/hub-wake', expect.anything());
    });

    it('R-MW-3: should continue notifying other targets if one fails', async () => {
      service.registerWebhook('ci-store:openclaw', 'http://openclaw:3000/wake', 'secret');

      let callCount = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Network error');
        return new Response('OK', { status: 200 });
      });

      await service.notify('test', {}, 'info');

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should support multiple registered webhooks', async () => {
      delete process.env.AGENT_WEBHOOK_URL;
      service.registerWebhook('ci-store:openclaw', 'http://openclaw:3000/wake', 's1');
      service.registerWebhook('ci-store:hermes', 'http://hermes:8080/wake', 's2');
      service.registerWebhook('ci-store:picoclaw', 'http://picoclaw:4000/wake', 's3');

      await service.notify('test', {}, 'info');

      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('should replace webhook on re-register for same appUrn', () => {
      service.registerWebhook('ci-store:openclaw', 'http://old:3000/wake', 'old-secret');
      service.registerWebhook('ci-store:openclaw', 'http://new:3000/wake', 'new-secret');

      const webhooks = service.getRegisteredWebhooks();
      expect(webhooks).toHaveLength(1);
      expect(webhooks[0]?.url).toBe('http://new:3000/wake');
      expect(webhooks[0]?.token).toBe('new-secret');
    });
  });
});
