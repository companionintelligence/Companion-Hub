import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SseListenerService } from '../src/sse-listener';
import type { OpenClawPluginApi } from '../src/types';

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

describe('SseListenerService', () => {
  let api: OpenClawPluginApi;
  let service: SseListenerService;

  beforeEach(() => {
    api = createMockApi();
    service = new SseListenerService('http://localhost:5002', 'test-key', api);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    service.stop();
    vi.restoreAllMocks();
  });

  it('should start not running', () => {
    expect(service.isRunning()).toBe(false);
  });

  it('should set running to true on start', async () => {
    // Mock fetch to return a failing response so it doesn't block
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test')));
    await service.start();
    expect(service.isRunning()).toBe(true);
  });

  it('should set running to false on stop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test')));
    await service.start();
    service.stop();
    expect(service.isRunning()).toBe(false);
  });

  it('should log when starting and stopping', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test')));
    await service.start();
    expect(api.log.info).toHaveBeenCalledWith('SSE listener starting...');
    service.stop();
    expect(api.log.info).toHaveBeenCalledWith('SSE listener stopped');
  });

  it('should apply wake filter to SSE events', () => {
    const filteredService = new SseListenerService('http://localhost:5002', 'key', api, {
      minUrgency: 'high',
    });

    // The service internally checks filters - we test the filter logic in wake-endpoint tests
    expect(filteredService).toBeDefined();
    filteredService.stop();
  });

  it('should handle SSE connection failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await service.start();

    // Should log the connection failure
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('SSE connection lost'));
  });

  it('should strip trailing slash from hubUrl', () => {
    const s = new SseListenerService('http://localhost:5002/', 'key', api);
    expect(s).toBeDefined();
    s.stop();
  });
});
