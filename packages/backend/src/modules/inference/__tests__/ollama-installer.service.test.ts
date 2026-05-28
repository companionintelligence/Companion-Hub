import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaInstallerService } from '../ollama-installer.service';

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

  beforeEach(async () => {
    execAsyncMock.mockReset();
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [OllamaInstallerService, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    service = module.get(OllamaInstallerService);
  });

  it('uses the official install script on macOS', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(service as never, 'delay').mockResolvedValue(undefined);
    const checkInstallationSpy = vi.spyOn(service, 'checkInstallation').mockResolvedValue({
      installed: true,
      needsInstall: false,
      version: '0.6.0',
      installPath: '/usr/local/bin/ollama',
    });
    execAsyncMock.mockResolvedValue({ stdout: '' });

    const result = await service.install();

    expect(execAsyncMock).toHaveBeenCalledWith('curl -fsSL https://ollama.com/install.sh | sh', expect.objectContaining({ timeout: 300000 }));
    expect(checkInstallationSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      message: 'Ollama installed successfully (0.6.0)',
    });
  });

  it('uses the official install script on Linux', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(service as never, 'delay').mockResolvedValue(undefined);
    const checkInstallationSpy = vi.spyOn(service, 'checkInstallation').mockResolvedValue({
      installed: true,
      needsInstall: false,
      version: '0.6.0',
      installPath: '/usr/local/bin/ollama',
    });
    execAsyncMock.mockResolvedValue({ stdout: '' });

    await service.install();

    expect(execAsyncMock).toHaveBeenCalledWith('curl -fsSL https://ollama.com/install.sh | sh', expect.objectContaining({ timeout: 300000 }));
    expect(checkInstallationSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the manual install command when Unix-like installation hits a permission error', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    execAsyncMock.mockRejectedValue(new Error('Permission denied'));

    const result = await service.install();

    expect(result).toEqual({
      success: false,
      message: 'Installation requires administrator permissions. Please install Ollama manually: curl -fsSL https://ollama.com/install.sh | sh',
    });
  });
});
