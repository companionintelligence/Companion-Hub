import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { GenerateAppEnvCommand } from '../generate-env-command';
import { LoggerService } from '@/core/logger/logger.service';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import type { AppUrn } from '@ci-hub/common/types';

describe('GenerateAppEnvCommand', () => {
  let command: GenerateAppEnvCommand;
  let errorReportingService: { reportAppFailure: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    errorReportingService = {
      reportAppFailure: vi.fn(),
    };

    const logger = mock<LoggerService>();
    const appHelpers = mock<AppHelpers>();

    const moduleRef = {
      get: vi.fn((token: unknown) => {
        if (token === LoggerService) return logger;
        if (token === AppHelpers) return appHelpers;
        if (token === ErrorReportingService) return errorReportingService;
        return undefined;
      }),
    } as unknown as ModuleRef;

    command = new GenerateAppEnvCommand(moduleRef, mock<Dockerode>());
  });

  it('reports generate_env failures as update failures', async () => {
    vi.spyOn(command as any, 'ensureAppDir').mockRejectedValue(new Error('env generation failed'));

    const result = await command.execute('urn:store:test-app' as AppUrn, {});

    expect(result).toEqual({
      success: false,
      message: 'env generation failed',
    });
    expect(errorReportingService.reportAppFailure).toHaveBeenCalledWith({
      appUrn: 'urn:store:test-app',
      phase: 'update',
      message: 'env generation failed',
    });
  });
});
