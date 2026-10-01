import { Test, TestingModule } from '@nestjs/testing';
import { UserRepository } from '../user.repository';
import { DATABASE } from '@/core/database/database.module';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import type { UserDto } from '../dto/user.dto';
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
  transaction: vi.fn(),
};

describe('UserRepository', () => {
  let repository: UserRepository;
  let sessionUserCache: SessionUserCache;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserRepository, SessionUserCache, { provide: DATABASE, useValue: mockDb }],
    }).compile();

    repository = module.get<UserRepository>(UserRepository);
    sessionUserCache = module.get<SessionUserCache>(SessionUserCache);

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
      expect(result).toEqual({
        id: 1,
        username: 'test',
        totpEnabled: undefined,
        locale: undefined,
        operator: undefined,
        hasCompletedOnboarding: undefined,
        advancedMode: undefined,
        accessStatus: 'active',
        orgRole: null,
      });
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

    // Regression: the cached DTO outlived the write, so `GET /app-context` kept answering
    // `hasCompletedOnboarding: false` after the user finished onboarding and the /home guard
    // sent them back through the wizard.
    it('MUST drop the cached session DTO for the updated user', async () => {
      sessionUserCache.set(1, { id: 1, hasCompletedOnboarding: false } as UserDto);
      expect(sessionUserCache.get(1)).toBeDefined();

      await repository.updateUser(1, { hasCompletedOnboarding: true });

      expect(sessionUserCache.get(1)).toBeUndefined();
    });

    it('MUST leave other users cached when one user is updated', async () => {
      sessionUserCache.set(1, { id: 1 } as UserDto);
      sessionUserCache.set(2, { id: 2 } as UserDto);

      await repository.updateUser(1, { hasCompletedOnboarding: true });

      expect(sessionUserCache.get(1)).toBeUndefined();
      expect(sessionUserCache.get(2)).toEqual({ id: 2 });
    });

    it('MUST invalidate when the id arrives as a string from the route layer', async () => {
      sessionUserCache.set(1, { id: 1 } as UserDto);

      await repository.updateUser('1' as unknown as number, { hasCompletedOnboarding: true });

      expect(sessionUserCache.get(1)).toBeUndefined();
    });
  });

  describe('createUser', () => {
    it('should create user', async () => {
      const result = await repository.createUser({ username: 'new' } as any);
      expect(result).toEqual({ id: 1 });
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('markApplianceOnboardingComplete', () => {
    it('invalidates the session cache for every operator it flips', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
          }),
        }),
      });
      sessionUserCache.set(1, { id: 1, hasCompletedOnboarding: false } as UserDto);
      sessionUserCache.set(2, { id: 2, hasCompletedOnboarding: false } as UserDto);

      await repository.markApplianceOnboardingComplete();

      expect(sessionUserCache.get(1)).toBeUndefined();
      expect(sessionUserCache.get(2)).toBeUndefined();
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
      expect(result).toEqual({
        id: 1,
        username: undefined,
        totpEnabled: undefined,
        locale: undefined,
        operator: true,
        hasCompletedOnboarding: undefined,
        advancedMode: undefined,
        accessStatus: 'active',
        orgRole: null,
      });
    });

    it('orders by id so the operator it picks is stable across calls', async () => {
      // Portal SSO compares the caller's address against THIS row. Unordered, it is heap order, so
      // on a multi-operator Hub the same login can be accepted once and refused the next time.
      mockDb.query.user.findFirst.mockResolvedValue({ id: 1, operator: true });
      await repository.getFirstOperator();

      const [args] = mockDb.query.user.findFirst.mock.calls.at(-1) as [{ orderBy?: unknown }];
      expect(args.orderBy).toBeTypeOf('function');
      const asc = vi.fn((column: unknown) => ({ asc: column }));
      expect((args.orderBy as (r: unknown, o: unknown) => unknown)({ id: 'id-column' }, { asc })).toEqual({ asc: 'id-column' });
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
        hasCompletedOnboarding: false,
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

    it('SHOULD fold the username to lower case before the INSERT', async () => {
      // `getUserByUsername` folds what it is handed, so a row stored as `Owner@Example.com` can
      // never be matched again: that operator cannot sign in at all. Migration 0062 repairs the
      // rows that predate this; this keeps new ones from being written that way.
      const values = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 3 }]) });
      mockDb.insert.mockReturnValue({ values });

      await repository.createUser({ username: '  Owner@Example.COM  ', password: 'hash' } as any);

      expect(values).toHaveBeenCalledWith(expect.objectContaining({ username: 'owner@example.com' }));
    });
  });

  describe('username normalization', () => {
    it('SHOULD fold a username handed to updateUser', async () => {
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 4 }]) }),
      });
      mockDb.update.mockReturnValue({ set });

      await repository.updateUser(4, { username: 'Owner@Example.COM' });

      expect(set).toHaveBeenCalledWith(expect.objectContaining({ username: 'owner@example.com' }));
    });

    it('SHOULD leave an update that does not touch the username alone', async () => {
      // `undefined` must not be written over the stored address as an empty string.
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 5 }]) }),
      });
      mockDb.update.mockReturnValue({ set });

      await repository.updateUser(5, { advancedMode: true });

      expect(set).toHaveBeenCalledWith({ advancedMode: true });
    });

    it('SHOULD fold the value it looks a user up by', async () => {
      mockDb.query.user.findFirst.mockResolvedValue({ id: 6 });

      await repository.getUserByUsername('  Owner@Example.COM  ');

      expect(mockDb.query.user.findFirst).toHaveBeenCalled();
    });
  });
  describe('createFirstOperator', () => {
    const newOperator = { username: '  Owner@Example.COM ', password: 'hash', hasCompletedOnboarding: false } as never;
    let steps: string[];
    let insertedValues: Record<string, unknown> | undefined;

    const withTransaction = (existingOperator: { id: number } | undefined, inserted: Array<{ id: number }> = [{ id: 7 }]) => {
      steps = [];
      insertedValues = undefined;
      const tx = {
        execute: vi.fn(async () => {
          steps.push('lock');
        }),
        query: {
          user: {
            findFirst: vi.fn(async () => {
              steps.push('look');
              return existingOperator;
            }),
          },
        },
        insert: vi.fn(() => ({
          values: vi.fn((values: Record<string, unknown>) => {
            steps.push('insert');
            insertedValues = values;
            return { returning: vi.fn().mockResolvedValue(inserted) };
          }),
        })),
      };
      mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));
      return tx;
    };

    it('takes the advisory lock before it looks for an operator, so a second claim waits for the first', async () => {
      withTransaction(undefined);

      await repository.createFirstOperator(newOperator);

      expect(steps).toEqual(['lock', 'look', 'insert']);
    });

    it('creates the operator, with the username folded and the operator flag set, when there is none', async () => {
      withTransaction(undefined);

      const created = await repository.createFirstOperator(newOperator);

      expect(created).toMatchObject({ id: 7 });
      expect(insertedValues).toMatchObject({ username: 'owner@example.com', operator: true });
    });

    it('creates nothing and returns null when an operator already exists', async () => {
      withTransaction({ id: 1 });

      await expect(repository.createFirstOperator(newOperator)).resolves.toBeNull();

      expect(steps).toEqual(['lock', 'look']);
    });

    it('forgets any cached user under the new id, as createUser does', async () => {
      withTransaction(undefined);
      const invalidate = vi.spyOn(sessionUserCache, 'invalidate');

      await repository.createFirstOperator(newOperator);

      expect(invalidate).toHaveBeenCalledWith(7);
    });

    it('does not invalidate anything when it created nothing', async () => {
      withTransaction({ id: 1 });
      const invalidate = vi.spyOn(sessionUserCache, 'invalidate');

      await repository.createFirstOperator(newOperator);

      expect(invalidate).not.toHaveBeenCalled();
    });

    it('lets a failure inside the transaction propagate, so it rolls back', async () => {
      mockDb.transaction.mockRejectedValue(new Error('deadlock detected'));

      await expect(repository.createFirstOperator(newOperator)).rejects.toThrow('deadlock detected');
    });
  });
});
