import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ApiKeyAdminController } from '../api-key-admin.controller';
import { ApiKeyAdminService } from '../api-key-admin.service';

/*
 * A key acts with the grants and role of the person who created it, so the
 * route records the signed-in person — and records nobody for a principal with
 * no person behind it, rather than whichever account it happens to carry.
 */
describe('ApiKeyAdminController — who created a key', () => {
  it.each([
    ['the signed-in person', { hubPrincipal: 'session', user: { id: 7 } }, 7],
    ['nobody for the CLI', { hubPrincipal: 'cli', user: { id: 1 } }, null],
    ['nobody for the Portal device push', { hubPrincipal: 'portal-device', user: { id: 1 } }, null],
  ])('records %s', async (_label, req, createdBy) => {
    const admin = mock<ApiKeyAdminService>();
    const controller = new ApiKeyAdminController(admin);

    await controller.createKey({ name: 'n8n', capability: 'write' } as never, req as unknown as Request);

    expect(admin.createKey).toHaveBeenCalledWith('n8n', 'write', createdBy);
  });
});
