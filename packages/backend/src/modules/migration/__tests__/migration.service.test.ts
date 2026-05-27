import { describe, it, expect, beforeEach } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MigrationService } from '../migration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';

describe('MigrationService', () => {
  let service: MigrationService;
  let logger: MockProxy<LoggerService>;
  let inferenceRouter: MockProxy<InferenceRouterService>;

  const makeRouterResult = (content: string) => ({
    data: { choices: [{ message: { content } }] },
    backend: 'ollama',
  });

  beforeEach(() => {
    logger = mock<LoggerService>();
    inferenceRouter = mock<InferenceRouterService>();
    service = new MigrationService(logger, inferenceRouter);
  });

  describe('generateImportScript', () => {
    it('returns script from AI response', async () => {
      const mockScript = '#!/bin/bash\n# Migration script\necho "Backing up data..."';
      inferenceRouter.routeChatCompletion.mockResolvedValue(makeRouterResult(mockScript));

      const result = await service.generateImportScript('umbrel', 'Running Nextcloud and Immich on Umbrel');

      expect(result.script).toBe(mockScript);
      expect(result.warnings).toEqual([]);
    });

    it('extracts WARNING comments from generated script', async () => {
      const mockScript = `#!/bin/bash
# WARNING: This script will stop all running containers
# NOTE: Database migration may take several minutes
echo "Starting migration..."`;
      inferenceRouter.routeChatCompletion.mockResolvedValue(makeRouterResult(mockScript));

      const result = await service.generateImportScript('casaos', 'Some setup');

      expect(result.warnings).toContain('This script will stop all running containers');
      expect(result.warnings).toContain('Database migration may take several minutes');
    });

    it('passes platform context in prompt', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue(makeRouterResult('#!/bin/bash'));

      await service.generateImportScript('unraid', 'My Unraid setup');

      const call = inferenceRouter.routeChatCompletion.mock.calls[0][0];
      const messages = call.messages as Array<{ role: string; content: string }>;
      const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';

      expect(userMsg).toContain('unraid');
      expect(userMsg).toContain('/mnt/user/appdata/');
    });

    it('handles empty AI response gracefully', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue({
        data: { choices: [] },
        backend: 'ollama',
      });

      const result = await service.generateImportScript('docker', 'Some docker setup');

      expect(result.script).toBe('');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('generateExportScript', () => {
    it('parses JSON response with composefile and script', async () => {
      const exportPayload = {
        composefile: 'version: "3"\nservices:\n  app:\n    image: nginx',
        script: '#!/bin/bash\n# Backup script',
        warnings: ['Some services use host networking'],
      };
      inferenceRouter.routeChatCompletion.mockResolvedValue(makeRouterResult(JSON.stringify(exportPayload)));

      const result = await service.generateExportScript('Nextcloud installed on CI-Hub');

      expect(result.composefile).toBe(exportPayload.composefile);
      expect(result.script).toBe(exportPayload.script);
      expect(result.warnings).toEqual(exportPayload.warnings);
    });

    it('falls back gracefully when AI response is not valid JSON', async () => {
      inferenceRouter.routeChatCompletion.mockResolvedValue(makeRouterResult('Sorry, I could not generate the export.'));

      const result = await service.generateExportScript('Some setup');

      expect(result.composefile).toBe('');
      expect(result.script).toBe('Sorry, I could not generate the export.');
      expect(result.warnings).toEqual([]);
    });
  });
});
