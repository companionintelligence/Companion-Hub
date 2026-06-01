import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { OllamaBackend } from '../backends/ollama.backend';

describe('OllamaInstallerService', () => {
  let service: OllamaInstallerService;
  let loggerService: MockProxy<LoggerService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let hostMetrics: MockProxy<HostMetricsService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    ollamaBackend = mock<OllamaBackend>();
    hostMetrics = mock<HostMetricsService>();
    ollamaBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:11434');
    hostMetrics.readHostProbe.mockResolvedValue(null);
    ollamaBackend.healthCheck.mockResolvedValue({
      running: false,
      healthy: false,
      modelsLoaded: [],
      error: 'connect ECONNREFUSED',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OllamaInstallerService,
        { provide: LoggerService, useValue: loggerService },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: HostMetricsService, useValue: hostMetrics },
      ],
    }).compile();

    service = module.get(OllamaInstallerService);
  });

  it('reports Ollama ready when the container endpoint is healthy', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({
      running: true,
      healthy: true,
      modelsLoaded: ['gemma4:4b'],
    });

    await expect(service.checkInstallation()).resolves.toEqual({
      ready: true,
      running: true,
      endpointUrl: 'http://host.docker.internal:11434',
      bridgeUnreachable: false,
      displayEndpoint: 'http://host.docker.internal:11434',
      hint: undefined,
      error: undefined,
    });
  });

  it('reports Ollama not ready when the container endpoint is down', async () => {
    await expect(service.checkInstallation()).resolves.toMatchObject({
      ready: false,
      running: false,
      endpointUrl: 'http://host.docker.internal:11434',
      bridgeUnreachable: true,
      error: 'connect ECONNREFUSED',
    });
  });

  it('returns bridge guidance when Docker bridge connection is refused', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({
      running: false,
      healthy: false,
      modelsLoaded: [],
      error: 'connect ECONNREFUSED 172.17.0.1:11434',
    });

    const status = await service.checkInstallation();
    expect(status.bridgeUnreachable).toBe(true);
    expect(status.hint).toContain('Ollama may already be installed');
    expect(status.hint).toContain('OLLAMA_HOST=0.0.0.0');
    expect(status.hint).not.toContain('On Linux, set');
  });

  it('uses host probe platform for bridge guidance on macOS hosts', async () => {
    hostMetrics.readHostProbe.mockResolvedValue({
      schemaVersion: 1,
      platform: 'darwin',
      cpuArch: 'arm64',
      source: 'init-host-probe',
      probedAt: '2026-01-01T00:00:00.000Z',
      host: {
        totalRamMb: 16384,
        availableRamMb: 8192,
        cpuCores: 8,
        diskTotalGb: 512,
        diskUsedGb: 128,
        diskMount: '/',
      },
    });

    const status = await service.checkInstallation();
    expect(status.hint).toContain('menu bar');
    expect(status.hint).not.toContain('systemctl');
  });

  it('handles an unexpected healthCheck throw gracefully', async () => {
    ollamaBackend.healthCheck.mockRejectedValue(new Error('socket hang up'));

    await expect(service.checkInstallation()).resolves.toEqual({
      ready: false,
      running: false,
      endpointUrl: 'http://host.docker.internal:11434',
      bridgeUnreachable: false,
      hint: undefined,
      error: 'socket hang up',
    });
    expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('returns host-first guidance when Ollama is not reachable on localhost', async () => {
    ollamaBackend.getBaseUrl.mockReturnValue('http://localhost:11434');
    ollamaBackend.healthCheck.mockResolvedValue({
      running: false,
      healthy: false,
      modelsLoaded: [],
      error: 'connect ECONNREFUSED 127.0.0.1:11434',
    });

    const result = await service.install();

    expect(result.success).toBe(false);
    expect(result.message).toContain("Ollama isn't reachable at http://localhost:11434");
    expect(result.message).toContain('Install it from ollama.com');
  });

  it('returns success when the Ollama endpoint is already ready', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({
      running: true,
      healthy: true,
      modelsLoaded: ['qwen3.6:35b'],
    });

    const result = await service.install();

    expect(result).toEqual({
      success: true,
      message: 'Ollama is running and reachable at http://host.docker.internal:11434.',
    });
  });
});
