import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { AppUrn } from '@ci-hub/common/types';
import { StopAppCommand } from '../stop-app-command';

describe('StopAppCommand', () => {
  const appUrn = 'ci-openclaw:ci-marketplace' as AppUrn;
  let command: StopAppCommand;
  let dockerService: { composeApp: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    dockerService = { composeApp: vi.fn().mockResolvedValue(undefined) };
    const services = new Map<unknown, unknown>([
      [LoggerService, { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }],
      [AppFilesManager, { getInstalledAppInfo: vi.fn().mockResolvedValue({ id: 'ci-openclaw' }) }],
      [DockerService, dockerService],
      [AppHelpers, { generateEnvFile: vi.fn().mockResolvedValue(undefined) }],
      [TraefikConfigService, { regenerateTraefikConfig: vi.fn().mockResolvedValue(undefined) }],
    ]);
    const moduleRef = { get: (token: unknown) => services.get(token) };
    command = new StopAppCommand(moduleRef as never, {} as never);
  });

  /*
   * An app installed from a listing that nested one folder inside another it can write to, before the
   * Hub refused that. Its compose is written only to run `down`, so the nesting doesn't stop the stop;
   * the next start checks the mounts again.
   */
  it("writes the app's compose for its teardown only, then takes it down", async () => {
    const ensureAppDir = vi.fn().mockResolvedValue(undefined);
    (command as unknown as { ensureAppDir: typeof ensureAppDir }).ensureAppDir = ensureAppDir;

    const result = await command.execute(appUrn, { exposureMode: 'local' } as never);

    expect(result.success).toBe(true);
    expect(ensureAppDir).toHaveBeenCalledWith(appUrn, expect.anything(), { createVolumeDirs: false, forTeardown: true });
    expect(dockerService.composeApp).toHaveBeenCalledWith(appUrn, 'down --remove-orphans');
  });
});
