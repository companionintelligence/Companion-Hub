import { EventPublisher } from '../event.publisher';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Connection, Publisher } from 'rabbitmq-client';

describe('EventPublisher', () => {
  let eventPublisher: EventPublisher;
  let loggerService: MockProxy<LoggerService>;
  let mockConnection: MockProxy<Connection>;
  let mockPublisher: MockProxy<Publisher>;

  beforeEach(() => {
    loggerService = mock<LoggerService>();
    mockConnection = mock<Connection>();
    mockPublisher = mock<Publisher>();

    mockConnection.createPublisher.mockReturnValue(mockPublisher as any);

    eventPublisher = new EventPublisher(mockConnection as any, loggerService, 'test-exchange');
  });

  describe('initialize', () => {
    it('should create publisher', () => {
      eventPublisher.initialize();
      expect(mockConnection.createPublisher).toHaveBeenCalledWith(
        expect.objectContaining({
          exchanges: expect.arrayContaining([expect.objectContaining({ exchange: 'test-exchange' })]),
        }),
      );
    });

    it('should log error on failure', () => {
      mockConnection.createPublisher.mockImplementation(() => {
        throw new Error('Fail');
      });
      expect(() => eventPublisher.initialize()).toThrow('Fail');
      expect(loggerService.error).toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    it('should throw if not initialized', async () => {
      await expect(eventPublisher.publish('key', {})).rejects.toThrow('EventPublisher not initialized');
    });

    it('should publish message', async () => {
      eventPublisher.initialize();
      await eventPublisher.publish('key', { foo: 'bar' });
      expect(mockPublisher.send).toHaveBeenCalledWith(expect.objectContaining({ exchange: 'test-exchange', routingKey: 'key' }), { foo: 'bar' });
    });

    it('should log error if send fails', async () => {
      eventPublisher.initialize();
      mockPublisher.send.mockImplementation(() => {
        throw new Error('Send fail');
      });
      await eventPublisher.publish('key', {});
      expect(loggerService.error).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should close publisher', async () => {
      eventPublisher.initialize();
      await eventPublisher.close();
      expect(mockPublisher.close).toHaveBeenCalled();
    });

    it('should do nothing if not initialized', async () => {
      await eventPublisher.close();
      expect(mockPublisher.close).not.toHaveBeenCalled();
    });
  });
});
