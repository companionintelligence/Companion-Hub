import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { OllamaBackend } from '../backends/ollama.backend';

const { execAsyncMock } = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return {
    ...actual,
    promisify: () => execAsyncMock,
  };
});

describe('OllamaInstallerService', () => {
  let service: OllamaInstallerService;
  let loggerService: MockProxy<LoggerService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

  beforeEach(async () => {
    execAsyncMock.mockReset();
    loggerService = mock<LoggerService>();
    ollamaBackend = mock<OllamaBackend>();
    ollamaBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:11434');
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

  it('reports Ollama ready when the configured endpoint is healthy even without a local CLI', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    execAsyncMock.mockRejectedValue(new Error('not found'));
    ollamaBackend.healthCheck.mockResolvedValue({
      running: true,
      healthy: true,
      modelsLoaded: ['phi4-mini'],
    });

    await expect(service.checkInstallation()).resolves.toEqual({
      installed: true,
      version: undefined,
      installPath: undefined,
      needsInstall: false,
      running: true,
      ready: true,
      endpointUrl: 'http://host.docker.internal:11434',
      error: undefined,
    });
  });

  it('reports Ollama installed but not ready when the CLI exists and the endpoint is down', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    execAsyncMock.mockResolvedValueOnce({ stdout: 'ollama version 0.6.0\n' }).mockResolvedValueOnce({ stdout: '/usr/local/bin/ollama\n' });

    await expect(service.checkInstallation()).resolves.toEqual({
      installed: true,
      version: 'ollama version 0.6.0',
      installPath: '/usr/local/bin/ollama',
      needsInstall: false,
      running: false,
      ready: false,
      endpointUrl: 'http://host.docker.internal:11434',
      error: 'connect ECONNREFUSED',
    });
  });

  it('returns a host-side install command for Unix-like platforms', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');

    const result = await service.install();

    expect(result).toEqual({
      success: false,
      message: 'Install Ollama on the host machine with: curl -fsSL https://ollama.com/install.sh | sh',
    });
  });
});
