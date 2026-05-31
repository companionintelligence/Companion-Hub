import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { OllamaBackend } from '../backends/ollama.backend';

describe('OllamaInstallerService', () => {
  let service: OllamaInstallerService;
  let loggerService: MockProxy<LoggerService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    ollamaBackend = mock<OllamaBackend>();
    ollamaBackend.getBaseUrl.mockReturnValue('http://ci-hub-ollama:11434');
    ollamaBackend.healthCheck.mockResolvedValue({
      running: false,
      healthy: false,
      modelsLoaded: [],
      error: 'connect ECONNREFUSED',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [OllamaInstallerService, { provide: LoggerService, useValue: loggerService }, { provide: OllamaBackend, useValue: ollamaBackend }],
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
      endpointUrl: 'http://ci-hub-ollama:11434',
      error: undefined,
    });
  });

  it('reports Ollama not ready when the container endpoint is down', async () => {
    await expect(service.checkInstallation()).resolves.toEqual({
      ready: false,
      running: false,
      endpointUrl: 'http://ci-hub-ollama:11434',
      error: 'connect ECONNREFUSED',
    });
  });

  it('handles an unexpected healthCheck throw gracefully', async () => {
    ollamaBackend.healthCheck.mockRejectedValue(new Error('socket hang up'));

    await expect(service.checkInstallation()).resolves.toEqual({
      ready: false,
      running: false,
      endpointUrl: 'http://ci-hub-ollama:11434',
      error: 'socket hang up',
    });
    expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('returns host-first guidance when Ollama is not reachable', async () => {
    const result = await service.install();

    expect(result).toEqual({
      success: false,
      message:
        "Ollama isn't reachable at http://ci-hub-ollama:11434. Install it from ollama.com and start it on the host (the Hub reaches it over host.docker.internal), then re-check.",
    });
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
      message: 'Ollama is running and reachable at http://ci-hub-ollama:11434.',
    });
  });
});
