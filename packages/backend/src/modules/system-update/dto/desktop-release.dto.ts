import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const desktopReleaseQuerySchema = z.object({
  // The page's own build environment. It only picks one of the two download servers, so a page
  // gets the installer its own trust check accepts. No URL is ever taken from the caller.
  environment: z.string().optional(),
  platform: z.enum(['linux', 'macos', 'windows']).optional(),
  arch: z.enum(['x86_64', 'aarch64']).optional(),
});

const desktopReleaseSchema = z.object({
  latestVersion: z.string().nullable(),
  downloadUrl: z.string().nullable(),
});

export class DesktopReleaseQueryDto extends createZodDto(desktopReleaseQuerySchema) {}
export class DesktopReleaseDto extends createZodDto(desktopReleaseSchema) {}
