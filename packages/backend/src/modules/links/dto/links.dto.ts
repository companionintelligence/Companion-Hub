import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

export const linkSchema = z.object({
  id: z.number(),
  title: z.string().min(1).max(20),
  description: z.string().max(50).nullable(),
  url: z.string().url(),
  iconUrl: z.union([z.string().url(), z.literal('')]).nullable(),
  userId: z.number(),
  isVisibleOnGuestDashboard: z.boolean().default(false),
});

const linkBodySchema = z.object({
  title: z.string().min(1).max(20),
  url: z.string().url(),
  description: z.string().max(50).optional(),
  iconUrl: z.union([z.string().url(), z.literal('')]).optional(),
  isVisibleOnGuestDashboard: z.boolean().default(false),
});

const editLinkBodySchema = z.object({
  title: z.string().min(1).max(20),
  url: z.string().url(),
  description: z.string().max(50).optional(),
  iconUrl: z.union([z.string().url(), z.literal('')]).optional(),
  isVisibleOnGuestDashboard: z.boolean().optional(),
});

const linksSchema = z.object({
  links: z.array(linkSchema),
});

export class LinkBodyDto extends createZodDto(linkBodySchema) {}

export class EditLinkBodyDto extends createZodDto(editLinkBodySchema) {}

export class LinksDto extends createZodDto(linksSchema) {}
