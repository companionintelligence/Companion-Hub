import { z } from 'zod';
import { HUB_INGRESS_HOST_PORTS } from '@/common/constants';
import { createZodDto } from '@/common/zod-dto';
import { customAppComposeSchema } from '@ci-hub/common/schemas';
import { HUB_ACTIONS } from '@/core/portal/hub-actions';

// Free-form display name shared by the custom-app and port-expose create
// flows. A URL-safe slug is derived from it server-side (see
// CustomAppsService.createCustomApp / PortExposeService.createPortExposeApp),
// mirroring how marketplace apps keep a human-readable `name` separate from
// their `id`. Control characters (incl. line breaks) are rejected so the name
// stays a single printable line when rendered into metadata/config files.
const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^\P{Cc}+$/u);

const createCustomAppSchema = z.object({
  name: displayNameSchema,
  config: customAppComposeSchema,
});

const createPortExposeAppSchema = z.object({
  name: displayNameSchema,
  port: z
    .number()
    .superRefine((port, ctx) => {
      // Checked before the range, so a port the Hub holds is named instead of "must be at least 1024".
      if (HUB_INGRESS_HOST_PORTS.includes(port)) {
        ctx.addIssue({
          code: 'custom',
          message: 'CUSTOM_APP_ERROR_PORT_HELD_BY_HUB',
          params: { port: String(port) },
          input: port,
          continue: false,
        });
      }
    })
    .min(1024)
    .max(65535),
  exposureMode: z.enum(['local', 'cloudflare', 'tailscale']),
  localSubdomain: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,63}$/)
    .optional(),
  publicDomain: z.string().trim().min(1).optional(),
});

export class CreateCustomAppDto extends createZodDto(createCustomAppSchema) {}

export class CreatePortExposeAppDto extends createZodDto(createPortExposeAppSchema) {}

const updatePortExposeAppSchema = createPortExposeAppSchema.omit({ name: true });

export class UpdatePortExposeAppDto extends createZodDto(updatePortExposeAppSchema) {}

const createCustomAppResponseSchema = z.object({
  appUrn: z.string(),
  appName: z.string(),
  storeId: z.string(),
});

export class CreateCustomAppResponseDto extends createZodDto(createCustomAppResponseSchema) {}

const updateCustomAppSchema = z.object({
  config: customAppComposeSchema,
});

export class UpdateCustomAppDto extends createZodDto(updateCustomAppSchema) {}

const updateAppMetadataDto = z.object({
  data: z.string(),
});

export class UpdateAppMetadataDto extends createZodDto(updateAppMetadataDto) {}

/**
 * What the signed-in person may do to a custom app (`MarketplaceWhoIsService.customAppActions`).
 * The UI shows a custom app's controls, and Create a custom app, from it; the routes still decide.
 */
const customAppAccessSchema = z.object({
  actions: z.array(z.enum(HUB_ACTIONS)),
});

export class CustomAppAccessDto extends createZodDto(customAppAccessSchema) {}
