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

/** See `TailscaleServicesStatus` in `tailscale-services.service.ts`. */
const tailscaleServicesStatusSchema = z.object({
  configured: z.boolean(),
  savedInHub: z.boolean(),
  tag: z.string(),
  ready: z.boolean(),
  blocker: z.enum(['not-set-up', 'node-not-running', 'node-signed-out', 'node-not-tagged', 'node-too-old', 'tailnet-unknown']).nullable(),
  node: z.object({
    running: z.boolean(),
    nodeFqdn: z.string().nullable(),
    tags: z.array(z.string()),
    version: z.string().nullable(),
  }),
  services: z.array(z.object({ appUrn: z.string(), name: z.string(), url: z.string() })),
});

export class TailscaleServicesStatusDto extends createZodDto(tailscaleServicesStatusSchema) {}

/** `POST /tailscale/services/setup`: the operator's Tailscale OAuth client. */
const tailscaleServicesSetupSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
  tag: z.string().trim().max(70).optional(),
});

export class TailscaleServicesSetupBody extends createZodDto(tailscaleServicesSetupSchema) {}
