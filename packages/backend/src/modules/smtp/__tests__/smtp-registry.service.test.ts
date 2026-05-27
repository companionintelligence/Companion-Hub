import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import fs from 'node:fs';
import { SmtpRegistryService } from '../smtp-registry.service';
import { LoggerService } from '@/core/logger/logger.service';

vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

const mockReadFile = vi.mocked(fs.promises.readFile);
const mockWriteFile = vi.mocked(fs.promises.writeFile);

describe('SmtpRegistryService', () => {
  let service: SmtpRegistryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined as never);
    const module: TestingModule = await Test.createTestingModule({
      providers: [SmtpRegistryService, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();
    service = module.get(SmtpRegistryService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOrCreateAppCredentials', () => {
    it('creates new credentials when none exist', async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);

      const creds = await service.getOrCreateAppCredentials('nextcloud');

      expect(creds.appName).toBe('nextcloud');
      expect(creds.username).toBe('nextcloud@hub.local');
      expect(creds.password).toHaveLength(48); // 24 bytes → 48 hex chars
      expect(creds.createdAt).toBeTruthy();
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('returns existing credentials on second call', async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);

      const first = await service.getOrCreateAppCredentials('gitea');
      const second = await service.getOrCreateAppCredentials('gitea');

      expect(first.password).toBe(second.password);
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('loads existing credentials from disk', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: {
            appName: 'gitea',
            username: 'gitea@hub.local',
            password: 'existingpw',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(stored) as never);

      const creds = await service.getOrCreateAppCredentials('gitea');

      expect(creds.password).toBe('existingpw');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('getAppCredentials', () => {
    it('returns null when app not registered', async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);

      const result = await service.getAppCredentials('unknown');
      expect(result).toBeNull();
    });

    it('returns credentials when registered', async () => {
      const stored = {
        version: 1,
        apps: {
          documenso: { appName: 'documenso', username: 'documenso@hub.local', password: 'pw', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(stored) as never);

      const result = await service.getAppCredentials('documenso');
      expect(result?.password).toBe('pw');
    });
  });

  describe('listRegisteredApps', () => {
    it('returns empty list when no apps registered', async () => {
      mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);

      const list = await service.listRegisteredApps();
      expect(list).toEqual([]);
    });

    it('returns all registered apps', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: { appName: 'gitea', username: 'gitea@hub.local', password: 'pw1', createdAt: '2024-01-01T00:00:00.000Z' },
          nextcloud: { appName: 'nextcloud', username: 'nextcloud@hub.local', password: 'pw2', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(stored) as never);

      const list = await service.listRegisteredApps();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.appName)).toEqual(expect.arrayContaining(['gitea', 'nextcloud']));
    });
  });

  describe('removeAppCredentials', () => {
    it('removes an app from the registry', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: { appName: 'gitea', username: 'gitea@hub.local', password: 'pw', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(stored) as never);

      await service.removeAppCredentials('gitea');

      const list = await service.listRegisteredApps();
      expect(list).toHaveLength(0);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe('SmtpRegistryService', () => {
  let service: SmtpRegistryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWriteFile.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [SmtpRegistryService, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();
    service = module.get(SmtpRegistryService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOrCreateAppCredentials', () => {
    it('creates new credentials when none exist', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const creds = await service.getOrCreateAppCredentials('nextcloud');

      expect(creds.appName).toBe('nextcloud');
      expect(creds.username).toBe('nextcloud@hub.local');
      expect(creds.password).toHaveLength(48); // 24 bytes → 48 hex chars
      expect(creds.createdAt).toBeTruthy();
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('returns existing credentials on second call', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const first = await service.getOrCreateAppCredentials('gitea');
      const second = await service.getOrCreateAppCredentials('gitea');

      expect(first.password).toBe(second.password);
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });

    it('loads existing credentials from disk', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: {
            appName: 'gitea',
            username: 'gitea@hub.local',
            password: 'existingpw',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(stored));

      const creds = await service.getOrCreateAppCredentials('gitea');

      expect(creds.password).toBe('existingpw');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('getAppCredentials', () => {
    it('returns null when app not registered', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await service.getAppCredentials('unknown');
      expect(result).toBeNull();
    });

    it('returns credentials when registered', async () => {
      const stored = {
        version: 1,
        apps: {
          documenso: { appName: 'documenso', username: 'documenso@hub.local', password: 'pw', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(stored));

      const result = await service.getAppCredentials('documenso');
      expect(result?.password).toBe('pw');
    });
  });

  describe('listRegisteredApps', () => {
    it('returns empty list when no apps registered', async () => {
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const list = await service.listRegisteredApps();
      expect(list).toEqual([]);
    });

    it('returns all registered apps', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: { appName: 'gitea', username: 'gitea@hub.local', password: 'pw1', createdAt: '2024-01-01T00:00:00.000Z' },
          nextcloud: { appName: 'nextcloud', username: 'nextcloud@hub.local', password: 'pw2', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(stored));

      const list = await service.listRegisteredApps();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.appName)).toEqual(expect.arrayContaining(['gitea', 'nextcloud']));
    });
  });

  describe('removeAppCredentials', () => {
    it('removes an app from the registry', async () => {
      const stored = {
        version: 1,
        apps: {
          gitea: { appName: 'gitea', username: 'gitea@hub.local', password: 'pw', createdAt: '2024-01-01T00:00:00.000Z' },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(stored));

      await service.removeAppCredentials('gitea');

      const list = await service.listRegisteredApps();
      expect(list).toHaveLength(0);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});
