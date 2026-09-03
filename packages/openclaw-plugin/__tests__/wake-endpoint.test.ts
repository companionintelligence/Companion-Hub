import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createWakeEndpointHandler, passesFilter, translateWakeMessage } from '../src/wake-endpoint';
import type { OpenClawPluginApi, WakePayload } from '../src/types';

function createMockApi(): OpenClawPluginApi {
  return {
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    wake: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe('Wake Endpoint', () => {
  let api: OpenClawPluginApi;

  beforeEach(() => {
    api = createMockApi();
  });

  describe('createWakeEndpointHandler', () => {
    it('should accept request when no wakeSecret configured (open mode)', async () => {
      const handler = createWakeEndpointHandler(api);
      const result = await handler({
        headers: {},
        body: { event: 'app.crashed', data: {}, urgency: 'high', timestamp: new Date().toISOString() },
      });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ received: true });
    });

    it('should reject request with wrong secret', async () => {
      const handler = createWakeEndpointHandler(api, 'my-secret');
      const result = await handler({
        headers: { authorization: 'Bearer wrong-secret' },
        body: { event: 'app.crashed', data: {}, urgency: 'high', timestamp: new Date().toISOString() },
      });
      expect(result.status).toBe(403);
    });

    it('should accept request with correct secret', async () => {
      const handler = createWakeEndpointHandler(api, 'my-secret');
      const result = await handler({
        headers: { authorization: 'Bearer my-secret' },
        body: { event: 'app.crashed', data: {}, urgency: 'high', timestamp: new Date().toISOString() },
      });
      expect(result.status).toBe(200);
    });

    it('should reject request with missing authorization when secret configured', async () => {
      const handler = createWakeEndpointHandler(api, 'my-secret');
      const result = await handler({
        headers: {},
        body: { event: 'test', data: {}, urgency: 'high', timestamp: new Date().toISOString() },
      });
      expect(result.status).toBe(403);
    });

    it('should reject invalid payload', async () => {
      const handler = createWakeEndpointHandler(api);
      const result = await handler({ headers: {}, body: { invalid: true } });
      expect(result.status).toBe(400);
    });

    it('should call api.wake with translated message', async () => {
      const handler = createWakeEndpointHandler(api);
      await handler({
        headers: {},
        body: {
          event: 'app.crashed',
          data: { appUrn: 'ci-store:nextcloud', previousStatus: 'running' },
          urgency: 'high',
          timestamp: new Date().toISOString(),
        },
      });
      expect(api.wake).toHaveBeenCalledWith(expect.stringContaining('nextcloud crashed'));
    });

    it('should filter events based on wakeFilter', async () => {
      const handler = createWakeEndpointHandler(api, undefined, { minUrgency: 'high' });
      const result = await handler({
        headers: {},
        body: { event: 'test', data: {}, urgency: 'info', timestamp: new Date().toISOString() },
      });
      expect(result.status).toBe(200);
      expect((result.body as any).filtered).toBe(true);
      expect(api.wake).not.toHaveBeenCalled();
    });
  });

  describe('passesFilter', () => {
    it('should pass all events when no filter', () => {
      expect(passesFilter({ event: 'test', data: {}, urgency: 'info', timestamp: '' })).toBe(true);
    });

    it('should filter by minimum urgency', () => {
      const filter = { minUrgency: 'medium' as const };
      expect(passesFilter({ event: 'test', data: {}, urgency: 'info', timestamp: '' }, filter)).toBe(false);
      expect(passesFilter({ event: 'test', data: {}, urgency: 'low', timestamp: '' }, filter)).toBe(false);
      expect(passesFilter({ event: 'test', data: {}, urgency: 'medium', timestamp: '' }, filter)).toBe(true);
      expect(passesFilter({ event: 'test', data: {}, urgency: 'high', timestamp: '' }, filter)).toBe(true);
    });

    it('should filter by event allowlist', () => {
      const filter = { events: ['app.crashed', 'system.update_available'] };
      expect(passesFilter({ event: 'app.crashed', data: {}, urgency: 'high', timestamp: '' }, filter)).toBe(true);
      expect(passesFilter({ event: 'some.other', data: {}, urgency: 'high', timestamp: '' }, filter)).toBe(false);
    });

    it('should apply AND logic for combined filters', () => {
      const filter = { minUrgency: 'high' as const, events: ['app.crashed'] };
      // Right event, wrong urgency
      expect(passesFilter({ event: 'app.crashed', data: {}, urgency: 'low', timestamp: '' }, filter)).toBe(false);
      // Right urgency, wrong event
      expect(passesFilter({ event: 'other', data: {}, urgency: 'high', timestamp: '' }, filter)).toBe(false);
      // Both pass
      expect(passesFilter({ event: 'app.crashed', data: {}, urgency: 'high', timestamp: '' }, filter)).toBe(true);
    });

    it('should pass all events when events array is empty', () => {
      const filter = { events: [] as string[] };
      expect(passesFilter({ event: 'anything', data: {}, urgency: 'info', timestamp: '' }, filter)).toBe(true);
    });
  });

  describe('translateWakeMessage', () => {
    it('should translate app.crashed event', () => {
      const payload: WakePayload = {
        event: 'app.crashed',
        data: { appUrn: 'ci-store:nextcloud', previousStatus: 'running' },
        urgency: 'high',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('CI-Hub alert (high)');
      expect(message).toContain('nextcloud crashed');
      expect(message).toContain('Previous status: running');
    });

    it('should translate system.update_available event', () => {
      const payload: WakePayload = {
        event: 'system.update_available',
        data: { current: '3.0.0', latest: '4.0.0' },
        urgency: 'low',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('System update available');
      expect(message).toContain('3.0.0');
      expect(message).toContain('4.0.0');
    });

    it('should translate system.mcp_ready event', () => {
      const payload: WakePayload = {
        event: 'system.mcp_ready',
        data: {},
        urgency: 'info',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('MCP server is ready');
    });

    it('should translate generic error events', () => {
      const payload: WakePayload = {
        event: 'install_error',
        data: { appUrn: 'ci-store:test' },
        urgency: 'high',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('install failed');
      expect(message).toContain('test');
    });

    it('should translate generic success events', () => {
      const payload: WakePayload = {
        event: 'update_success',
        data: { appUrn: 'ci-store:homeassistant' },
        urgency: 'info',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('update succeeded');
    });

    it('should translate registration.state_changed event', () => {
      const payload: WakePayload = {
        event: 'registration.state_changed',
        data: { from: 'unregistered', to: 'provisioning' },
        urgency: 'medium',
        timestamp: new Date().toISOString(),
      };
      const message = translateWakeMessage(payload);
      expect(message).toContain('Registration phase changed');
      expect(message).toContain('unregistered');
      expect(message).toContain('provisioning');
    });
  });
});
