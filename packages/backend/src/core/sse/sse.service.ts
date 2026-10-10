import { DockerService } from '@/modules/docker/docker.service';
import { Injectable, type MessageEvent, type OnApplicationShutdown } from '@nestjs/common';
import type { SSE, Topic } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { Observable, Subject, type Subscription, interval, merge } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { resolveHubBuildInfo } from '../build-info/hub-build-info';
import { ConfigurationService } from '../config/configuration.service';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class SSEService implements OnApplicationShutdown {
  private cleanupSubscription: Subscription;

  /** The image's build stamp, resolved as `GET /api/hub/build` resolves it; it cannot change while the process runs. */
  private readonly buildVersion = resolveHubBuildInfo().version;

  constructor(
    private readonly logger: LoggerService,
    private readonly dockerService: DockerService,
    private readonly config: ConfigurationService,
  ) {
    this.cleanupSubscription = interval(1000 * 60).subscribe(() => {
      this.topics.forEach((topic, key) => {
        if (!topic.observed) {
          this.logger.debug(`Killing topic ${key}`);
          topic.complete();
          this.topics.delete(key);
        }
      });
    });
  }

  onApplicationShutdown() {
    this.cleanupSubscription.unsubscribe();
    for (const topic of this.topics.values()) {
      topic.complete();
    }
    this.topics.clear();
  }

  private topics: Map<Topic, Subject<MessageEvent>> = new Map();

  /**
   * The latest progress tick of each install that is still running, by app. A page opened
   * mid-install has no tick of its own until the next one, which on a long download can be
   * minutes away, so every new `app` subscriber gets these after the hello. Any other event
   * for the app (success, error, cancel, a new attempt) ends the install's entry.
   */
  private readonly installProgress = new Map<string, MessageEvent>();

  /**
   * Emits an event to the specified topic.
   */
  emit<T extends Topic>(topic: T, data: Extract<SSE, { topic: T }>['data'], appUrn?: AppUrn) {
    let formattedTopic = topic;

    if (appUrn) {
      // We want to use this topic for a specific app
      formattedTopic = `${topic}:${appUrn}` as T;
    } else if (topic === 'app' && 'appUrn' in data) {
      if (data.event === 'status_change' && data.appStatus === 'installing' && typeof data.progress === 'number') {
        this.installProgress.set(data.appUrn, { type: 'message', data: JSON.stringify(data) });
      } else {
        this.installProgress.delete(data.appUrn);
      }
    }

    let currentTopic = this.topics.get(formattedTopic);
    if (!currentTopic) {
      currentTopic = new Subject<MessageEvent>();
      this.topics.set(formattedTopic, currentTopic);
    }

    const event: MessageEvent = { type: 'message', data: JSON.stringify(data) };

    currentTopic.next(event);
  }

  /**
   * Whether a client is listening on `topic` right now. An event sent only once
   * reaches nobody while every client is disconnected, for example while they
   * reconnect after the Hub restarts.
   */
  hasSubscribers(topic: Topic): boolean {
    return this.topics.get(topic)?.observed ?? false;
  }

  /**
   * Gets an observable for the specified topic.
   * If the topic does not exist, it creates it.
   */
  getTopicObservable(topic: Topic, appUrn?: AppUrn): Observable<MessageEvent> {
    let formattedTopic = topic;

    if (appUrn) {
      // We want to use this topic for a specific app
      formattedTopic = `${topic}:${appUrn}` as Topic;
    }

    let currentTopic = this.topics.get(formattedTopic);
    if (!currentTopic) {
      currentTopic = new Subject<MessageEvent>();
      this.topics.set(formattedTopic, currentTopic);
    }

    const heartbeat = interval(30_000).pipe(map(() => ({ type: 'heartbeat', data: 'ping' }) satisfies MessageEvent));

    return merge(currentTopic.asObservable(), heartbeat);
  }

  /**
   * The `app` topic with a `hub_hello` prelude: the first message every subscriber gets
   * is this Hub's version. See `hubHelloEventSchema` in `@ci-hub/common/schemas` for why
   * it exists. It is built per subscription, not emitted on the topic, because a Hub
   * that has just started has no subscribers to emit to — the clients are all mid-reconnect.
   * The latest tick of any install still running follows the hello (`installProgress`).
   */
  getAppEventsObservable(): Observable<MessageEvent> {
    // `buildVersion` is the image stamp `GET /api/hub/build` serves, which image builds set to the
    // page bundle's version, so a tab compares like with like. `version` stays the env file's, which
    // the pending-update flow compares. An unstamped image sends no `buildVersion`.
    const hello: MessageEvent = {
      type: 'message',
      data: JSON.stringify({
        event: 'hub_hello',
        version: this.config.getConfig().version,
        ...(this.buildVersion ? { buildVersion: this.buildVersion } : {}),
      } satisfies Extract<SSE, { topic: 'app' }>['data']),
    };
    return this.getTopicObservable('app').pipe(startWith(hello, ...this.installProgress.values()));
  }

  /**
   * Creates an observable for logs stream.
   * It listens to the logs stream and emits the logs to the specified topic.
   */
  async getLogStreamObservable(topic: Topic, maxLines: number, appUrn?: AppUrn): Promise<Observable<MessageEvent>> {
    const { on, kill } = await this.dockerService.getLogsStream(maxLines, appUrn);

    return new Observable((subscriber) => {
      const observable = this.getTopicObservable(topic, appUrn);

      const subscription = observable.subscribe({
        next: (event) => subscriber.next(event),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });

      on('data', async (data) => {
        try {
          const lines = data
            .toString()
            .split(/(?:\r\n|\r|\n)/g)
            .filter(Boolean);

          const payload = appUrn ? { appUrn, lines, event: 'newLogs' as const } : { lines, event: 'newLogs' as const };
          this.emit(topic, payload, appUrn);
        } catch (error) {
          this.logger.error('Error processing logs:', error);
        }
      });

      return () => {
        kill();
        subscription.unsubscribe();
      };
    });
  }
}
