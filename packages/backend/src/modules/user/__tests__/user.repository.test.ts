import { Test, TestingModule } from '@nestjs/testing';
import { UserRepository } from '../user.repository';
import { DATABASE } from '@/core/database/database.module';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockDb = {
  query: {
    user: {
      findFirst: vi.fn(),
    },
  },
  update: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
};

describe('UserRepository', () => {
  let repository: UserRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserRepository, { provide: DATABASE, useValue: mockDb }],
    }).compile();

    repository = module.get<UserRepository>(UserRepository);

    vi.clearAllMocks();

    // Setup chaining mocks
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    });

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
      }),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 1 }]),
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserByUsername', () => {
    it('should return user', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({ id: 1, username: 'test' });
      const result = await repository.getUserByUsername('test');
      expect(result).toEqual({ id: 1, username: 'test' });
      expect(mockDb.query.user.findFirst).toHaveBeenCalled();
    });
  });

  describe('getUserById', () => {
    it('should return user', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({ id: 1 });
      const result = await repository.getUserById(1);
      expect(result).toEqual({ id: 1 });
    });
  });

  describe('getUserDtoById', () => {
    it('should return user dto', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({ id: 1, username: 'test' });
      const result = await repository.getUserDtoById(1);
      expect(result).toEqual({ id: 1, username: 'test' });
      // Verify columns selection logic?
      // Expect finding with specific options
      expect(mockDb.query.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: expect.any(Object),
        }),
      );
    });
  });

  describe('updateUser', () => {
    it('should update user', async () => {
      const result = await repository.updateUser(1, { username: 'updated' });
      expect(result).toEqual({ id: 1 });
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('createUser', () => {
    it('should create user', async () => {
      const result = await repository.createUser({ username: 'new' } as any);
      expect(result).toEqual({ id: 1 });
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('getOperators', () => {
    it('should return operators', async () => {
      const result = await repository.getOperators();
      expect(result).toHaveLength(1);
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('getFirstOperator', () => {
    it('should return first operator', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({ id: 1, operator: true });
      const result = await repository.getFirstOperator();
      expect(result).toEqual({ id: 1, operator: true });
    });
  });

  describe('advancedMode field', () => {
    it('MUST include advancedMode in user DTO via getUserDtoById', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({
        id: 1,
        username: 'test',
        totpEnabled: false,
        locale: 'en',
        operator: true,
        hasSeenWelcome: false,
        advancedMode: true,
      });
      const result = await repository.getUserDtoById(1);
      expect(result).toHaveProperty('advancedMode', true);

      // Verify getUserDtoById passes columns config including advancedMode
      const callArgs = mockDb.query.user.findFirst.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs).toHaveProperty('columns');
    });

    it('SHOULD default advancedMode to false for new users', async () => {
      // The schema defines advancedMode with .default(false).notNull()
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 2, advancedMode: false }]),
        }),
      });
      const result = await repository.createUser({ username: 'newuser' } as any);
      expect(result?.advancedMode).toBe(false);
    });
  });
});
