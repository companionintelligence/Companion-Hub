import { castAppUrn } from '@/common/helpers/app-helpers';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { Controller, type MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { StreamAppLogsQueryDto, StreamHubLogsQueryDto } from './dto/sse.dto';
import { SSEService } from './sse.service';

@UseGuards(AuthGuard)
@Controller('sse')
export class SSEController {
  constructor(private readonly sseService: SSEService) {}

  @Sse('app')
  appEvents(): Observable<MessageEvent> {
    const observable = this.sseService.getTopicObservable('app');

    return observable;
  }

  @Sse('app-logs')
  async appLogsEvents(@Query() query: StreamAppLogsQueryDto): Promise<Observable<MessageEvent>> {
    const { appUrn, maxLines = 300 } = query;

    return this.sseService.getLogStreamObservable('app-logs', maxLines, castAppUrn(appUrn));
  }

  @Sse('ci-hub-logs')
  async hubLogsEvents(@Query() query: StreamHubLogsQueryDto): Promise<Observable<MessageEvent>> {
    const { maxLines = 300 } = query;

    return this.sseService.getLogStreamObservable('ci-hub-logs', maxLines);
  }
}
