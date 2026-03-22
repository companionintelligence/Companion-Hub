import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';

const streamAppQuerySchema = type({
  appUrn: 'string',
  maxLines: 'number.integer | string.integer.parse?',
});

const streamHubQuerySchema = type({
  maxLines: 'number.integer | string.integer.parse?',
});

export class StreamAppLogsQueryDto extends createArkDto(streamAppQuerySchema, { name: 'StreamAppLogsQueryDto', input: true }) {}
export class StreamHubLogsQueryDto extends createArkDto(streamHubQuerySchema, { name: 'StreamHubLogsQueryDto', input: true }) {}
