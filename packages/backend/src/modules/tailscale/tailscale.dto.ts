import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const tailscalePeerDeviceSchema = z.object({
  id: z.string().optional(),
  nodeFqdn: z.string(),
  hostname: z.string().nullable(),
  ip: z.string().nullable(),
  online: z.boolean().optional(),
  os: z.string().nullable().optional(),
});

/** See `TailscaleServePermission` in `tailscale.service.ts`. */
const tailscaleServePermissionSchema = z.object({
  denied: z.boolean(),
  remedy: z.string().nullable(),
  deniedSince: z.string().nullable(),
});

/**
 * `GET /tailscale/status`: what `TailscaleService.getStatus` reads from tailscaled, plus whether
 * tailscaled refuses the Hub's Tailscale Serve changes. Every field of `TailscaleStatus` is listed,
 * because parsing drops any field the schema does not name.
 */
const tailscaleStatusSchema = z.object({
  installed: z.boolean(),
  connected: z.boolean(),
  version: z.string().nullable(),
  hostname: z.string().nullable(),
  nodeFqdn: z.string().nullable(),
  tailnet: z.string().nullable(),
  ip: z.string().nullable(),
  supportsServices: z.boolean(),
  /** True when HTTPS certificates (and therefore Tailscale Serve) are enabled for the tailnet. */
  httpsAvailable: z.boolean(),
  backendState: z.string().nullable(),
  authUrl: z.string().nullable(),
  peers: z.array(tailscalePeerDeviceSchema).optional(),
  servePermission: tailscaleServePermissionSchema,
});

export class TailscaleStatusDto extends createZodDto(tailscaleStatusSchema) {}
