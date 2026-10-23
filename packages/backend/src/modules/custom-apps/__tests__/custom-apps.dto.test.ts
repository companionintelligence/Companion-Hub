import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '@/common/zod-dto';
import { CreateCustomAppDto, UpdateCustomAppDto } from '../dto/custom-apps.dto';

/*
 * The Hub finds an app's containers by `ci-hub.appurn` and the other labels it writes. A custom app
 * that set one to another app's URN had its container taken for that app's, so a save that sets one
 * is refused with a 400 that names the label.
 */
describe('custom app DTOs — reserved labels', () => {
  const config = (extraLabels: Record<string, string>) => ({
    schemaVersion: 2,
    services: [{ name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80, extraLabels }],
  });

  const refusal = (metatype: typeof CreateCustomAppDto | typeof UpdateCustomAppDto, body: unknown) => {
    try {
      new ZodValidationPipe().transform(body, { metatype });
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse() as { message: Array<{ message: string; path: unknown[]; params?: unknown }> };
    }
    throw new Error('the body was accepted');
  };

  it.each([
    ['an update', UpdateCustomAppDto, { config: config({ 'ci-hub.appurn': 'n8n:ci-marketplace' }) }],
    ['a create', CreateCustomAppDto, { name: 'My App', config: config({ 'ci-hub.appurn': 'n8n:ci-marketplace' }) }],
  ])('answers 400 naming the label on %s', (_label, metatype, body) => {
    const response = refusal(metatype, body);

    expect(response.message).toContainEqual(
      expect.objectContaining({
        message: 'CUSTOM_APP_ERROR_LABEL_RESERVED',
        path: ['config', 'services', 0, 'extraLabels', 'ci-hub.appurn'],
        params: { label: 'ci-hub.appurn' },
      }),
    );
  });

  // One Traefik reads every app's labels, so a router of this app's could send its traffic to another app's backend.
  it('answers 400 naming a Traefik label that reaches another app', () => {
    const label = 'traefik.http.routers.{{CI_HUB_APP_ID}}.service';
    const response = refusal(UpdateCustomAppDto, { config: config({ [label]: 'n8n-ci-marketplace' }) });

    expect(response.message).toContainEqual(
      expect.objectContaining({
        message: 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN',
        path: ['config', 'services', 0, 'extraLabels', label],
        params: { label, target: 'n8n-ci-marketplace', placeholder: '{{CI_HUB_APP_ID}}' },
      }),
    );
  });

  it('keeps accepting labels outside the Hub namespace', () => {
    const body = { config: config({ 'com.example.team': 'web' }) };

    expect(new ZodValidationPipe().transform(body, { metatype: UpdateCustomAppDto })).toMatchObject(body);
  });
});
