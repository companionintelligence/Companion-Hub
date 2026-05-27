import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { SystemInspectorService } from '../system-inspector.service';

describe('SystemInspectorService', () => {
  let service: SystemInspectorService;
  let docker: MockProxy<Dockerode>;
  let appsRepository: MockProxy<AppsRepository>;
  let portManager: MockProxy<PortManagerService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemInspectorService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: PortManagerService, useValue: mock<PortManagerService>() },
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: DOCKERODE, useValue: mock<Dockerode>() },
      ],
    }).compile();

    service = module.get(SystemInspectorService);
    docker = module.get(DOCKERODE);
    appsRepository = module.get(AppsRepository);
    portManager = module.get(PortManagerService);

    portManager.getAllAllocations.mockResolvedValue([]);
  });

  it('prioritizes weak internet-facing credentials and risky runtime posture', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'vaultwarden',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        exposureMode: 'cloudflare',
        config: {
          adminPassword: 'admin',
          adminUsername: 'admin',
        },
      },
    ] as any);

    docker.listContainers.mockResolvedValue([
      {
        Id: 'container-1',
        Names: ['/vaultwarden'],
        Image: 'vaultwarden/server:latest',
        State: 'running',
        Status: 'Up 2 minutes',
        Ports: [],
        Labels: { 'ci-os-hub.appurn': 'vaultwarden:ci-marketplace' },
        Created: Math.floor(Date.now() / 1000),
      },
    ] as any);

    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        Config: { User: '', Image: 'vaultwarden/server:latest' },
        HostConfig: {
          Privileged: true,
          CapAdd: ['SYS_ADMIN'],
          NetworkMode: 'bridge',
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
        Mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }],
      }),
    } as any);

    const result = await service.getSecurityDigest();

    expect(result.summary.critical).toBeGreaterThanOrEqual(1);
    expect(result.summary.high).toBeGreaterThanOrEqual(2);
    expect(result.summary.score).toBeLessThan(50);
    expect(result.findings.map((finding) => finding.title)).toEqual(
      expect.arrayContaining([
        'vaultwarden appears to use weak or default credentials',
        'vaultwarden can control the Docker host',
        'vaultwarden is internet-facing',
      ]),
    );
    expect(result.apps[0]).toMatchObject({
      appName: 'vaultwarden',
      exposure: 'cloudflare',
    });
    expect(result.apps[0]?.score).toBeLessThan(50);
  });

  it('reports a clean posture when an app is pinned, local-only, and minimally privileged', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'jellyfin',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        exposureMode: 'local',
        config: {
          adminPassword: 'correct-horse-battery-staple',
        },
      },
    ] as any);

    docker.listContainers.mockResolvedValue([
      {
        Id: 'container-2',
        Names: ['/jellyfin'],
        Image: 'ghcr.io/jellyfin/jellyfin:10.9.1',
        State: 'running',
        Status: 'Up 5 minutes',
        Ports: [],
        Labels: { 'ci-os-hub.appurn': 'jellyfin:ci-marketplace' },
        Created: Math.floor(Date.now() / 1000),
      },
    ] as any);

    docker.getContainer.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({
        Config: { User: '1000', Image: 'ghcr.io/jellyfin/jellyfin:10.9.1' },
        HostConfig: {
          Privileged: false,
          CapAdd: [],
          NetworkMode: 'bridge',
          Binds: [],
        },
        Mounts: [],
      }),
    } as any);

    const result = await service.getSecurityDigest();

    expect(result.summary.findings).toBe(0);
    expect(result.summary.score).toBe(100);
    expect(result.overview).toContain('No immediate security issues');
    expect(result.apps[0]).toMatchObject({
      appName: 'jellyfin',
      exposure: 'local',
      score: 100,
      findings: 0,
    });
  });
});
