import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const smtpConnectionInfoSchema = z.object({
  host: z.string(),
  port: z.number(),
  security: z.enum(['none', 'starttls', 'tls']),
});

const smtpStatusSchema = z.object({
  enabled: z.boolean(),
  connection: smtpConnectionInfoSchema,
});

const appSmtpCredentialsSchema = z.object({
  appName: z.string(),
  username: z.string(),
  password: z.string(),
  createdAt: z.string(),
});

const dnsRecordStatusSchema = z.object({
  configured: z.boolean(),
  value: z.string().nullable(),
  expected: z.string(),
  error: z.string().optional(),
});

const smtpDnsCheckResultSchema = z.object({
  domain: z.string(),
  mx: dnsRecordStatusSchema,
  spf: dnsRecordStatusSchema,
  dkim: dnsRecordStatusSchema,
  dmarc: dnsRecordStatusSchema,
});

export class SmtpStatusDto extends createZodDto(smtpStatusSchema) {}
export class AppSmtpCredentialsDto extends createZodDto(appSmtpCredentialsSchema) {}
export class SmtpDnsCheckResultDto extends createZodDto(smtpDnsCheckResultSchema) {}
