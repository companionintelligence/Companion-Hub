import { DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppEventsQueue, appEventResultSchema, appEventSchema } from './entities/app-events';
import { RepoEventsQueue, repoCommandResultSchema, repoCommandSchema } from './entities/repo-events';
import { SystemEventsQueue, systemCommandResultSchema, systemCommandSchema } from './entities/system-events';
import { QueueFactory } from './queue.factory';
import { QueueHealthIndicator } from './queue.health';

export function scopedQueueName(queueName: string, configuredPrefix = process.env.RABBITMQ_QUEUE_PREFIX): string {
  const prefix = configuredPrefix?.trim();
  return prefix ? `${prefix}-${queueName}` : queueName;
}

@Module({
  imports: [TerminusModule],
  providers: [
    QueueHealthIndicator,
    QueueFactory,
    {
      provide: AppEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService) => {
        const eventsTimeoutMinutes = config.get('userSettings').eventsTimeout;
        const timeoutMinutes = Math.max(eventsTimeoutMinutes, Number(DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES));
        const timeout = timeoutMinutes * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: scopedQueueName('app-events-queue'),
          workers: 3,
          eventSchema: appEventSchema,
          // Must match AppEventsQueue's Queue<T, R> type: publish() validates the
          // RPC reply against this schema and zod strips unknown keys, so the
          // minimal default would silently drop result fields (e.g. warningCode).
          resultSchema: appEventResultSchema,
          timeout: timeout,
        });
      },
      inject: [QueueFactory, ConfigurationService],
    },
    {
      provide: RepoEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService) => {
        const timeout = config.get('userSettings').eventsTimeout * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: scopedQueueName('repo-queue'),
          workers: 3,
          eventSchema: repoCommandSchema,
          resultSchema: repoCommandResultSchema,
          timeout: timeout,
        });
      },
      inject: [QueueFactory, ConfigurationService],
    },
    {
      provide: SystemEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService) => {
        const timeout = config.get('userSettings').eventsTimeout * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: scopedQueueName('system-events-queue'),
          workers: 1,
          eventSchema: systemCommandSchema,
          resultSchema: systemCommandResultSchema,
          timeout: timeout,
        });
      },
      inject: [QueueFactory, ConfigurationService],
    },
  ],
  exports: [AppEventsQueue, RepoEventsQueue, SystemEventsQueue, QueueHealthIndicator],
})
export class QueueModule {}
