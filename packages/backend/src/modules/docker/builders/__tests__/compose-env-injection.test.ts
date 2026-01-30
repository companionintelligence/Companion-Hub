import { createAppUrn } from '@/common/helpers/app-helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ServiceInput } from '@runtipi/common/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { DockerComposeBuilder } from '../compose.builder';

describe('DockerComposeBuilder Env File', () => {
  let composeBuilder: DockerComposeBuilder;
  const appUrn = createAppUrn('test-app', 'test-store');
  const dummyForm: AppEventFormInput = {
    appId: 'test-app',
    appStoreId: 'test-store',
    version: '1.0.0',
    port: 8080,
    exposedLocal: false,
    environment: {},
  };

  beforeEach(() => {
    composeBuilder = new DockerComposeBuilder('example.com', 'local.ci');
  });

  it('should add env_file to services when envFile path is provided', async () => {
    const services: ServiceInput[] = [
      {
        name: 'test-service',
        image: 'test-image',
        isMain: true,
      },
    ];

    const compose = await composeBuilder.getDockerCompose(services, dummyForm, appUrn, '10.0.0.0/24', 'example.com', 'local.ci', '/path/to/app.env');

    expect(compose).toContain('env_file:');
    expect(compose).toContain('- /path/to/app.env');
  });

  it('should not add env_file when envFile path is not provided', async () => {
    const services: ServiceInput[] = [
      {
        name: 'test-service',
        image: 'test-image',
        isMain: true,
      },
    ];

    const compose = await composeBuilder.getDockerCompose(services, dummyForm, appUrn, '10.0.0.0/24', 'example.com', 'local.ci');

    expect(compose).not.toContain('env_file:');
  });
});
