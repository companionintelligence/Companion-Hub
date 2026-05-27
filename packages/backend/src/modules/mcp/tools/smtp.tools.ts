import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { SmtpService } from '@/modules/smtp/smtp.service';
import { SmtpRegistryService } from '@/modules/smtp/smtp-registry.service';
import { SmtpDnsService } from '@/modules/smtp/smtp-dns.service';

@Injectable()
export class SmtpTools implements OnModuleInit {
  constructor(
    private readonly logger: LoggerService,
    private readonly registry: McpToolRegistry,
    private readonly smtpService: SmtpService,
    private readonly smtpRegistryService: SmtpRegistryService,
    private readonly smtpDnsService: SmtpDnsService,
  ) {}

  onModuleInit() {
    // ─── hub_get_smtp_status ─────────────────────────────────────────
    this.registry.register({
      name: 'hub_get_smtp_status',
      description: 'Get the current Hub SMTP service status, including whether it is enabled and its connection parameters.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getSmtpStatus(),
    });

    // ─── hub_register_smtp_app ───────────────────────────────────────
    this.registry.register({
      name: 'hub_register_smtp_app',
      description: 'Generate or retrieve Hub SMTP credentials for an installed app.',
      inputSchema: {
        type: 'object',
        properties: {
          appName: { type: 'string', description: 'Name of the app to register (e.g. "nextcloud", "gitea")' },
        },
        required: ['appName'],
      },
      handler: (p) => this.registerSmtpApp(p as { appName: string }),
    });

    // ─── hub_list_smtp_apps ──────────────────────────────────────────
    this.registry.register({
      name: 'hub_list_smtp_apps',
      description: 'List all apps that have registered Hub SMTP credentials.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listSmtpApps(),
    });

    // ─── hub_test_smtp ───────────────────────────────────────────────
    this.registry.register({
      name: 'hub_test_smtp',
      description: 'Test Hub SMTP connectivity by verifying the service is enabled and connection parameters are set.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.testSmtp(),
    });

    // ─── hub_check_smtp_dns ──────────────────────────────────────────
    this.registry.register({
      name: 'hub_check_smtp_dns',
      description: 'Verify DNS records (MX, SPF, DKIM, DMARC) required for direct email delivery from the Hub domain.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Hub public domain to check (e.g. "yourdomain.com")' },
          hubIp: { type: 'string', description: "Hub's public IP address" },
          dkimSelector: { type: 'string', description: 'DKIM selector (default: "default")' },
        },
        required: ['domain', 'hubIp'],
      },
      handler: (p) => this.checkSmtpDns(p as { domain: string; hubIp: string; dkimSelector?: string }),
    });

    this.logger.info('[SmtpTools] Registered 5 SMTP MCP tools');
  }

  async getSmtpStatus() {
    return this.smtpService.getStatus();
  }

  async registerSmtpApp(params: { appName: string }) {
    const credentials = await this.smtpRegistryService.getOrCreateAppCredentials(params.appName);
    const connectionInfo = this.smtpService.getConnectionInfo();
    return {
      appName: credentials.appName,
      username: credentials.username,
      smtpHost: connectionInfo.host,
      smtpPort: connectionInfo.port,
      createdAt: credentials.createdAt,
    };
  }

  async listSmtpApps() {
    const apps = await this.smtpRegistryService.listRegisteredApps();
    return {
      apps: apps.map((a) => ({
        appName: a.appName,
        username: a.username,
        createdAt: a.createdAt,
      })),
      count: apps.length,
    };
  }

  async testSmtp() {
    const status = this.smtpService.getStatus();
    if (!status.enabled) {
      return {
        success: false,
        message: 'Hub SMTP service is not enabled. Set HUB_SMTP_ENABLED=true to enable it.',
      };
    }
    return {
      success: true,
      message: `Hub SMTP service is enabled. Internal endpoint: ${status.connection.host}:${status.connection.port} (security: ${status.connection.security})`,
      connection: status.connection,
    };
  }

  async checkSmtpDns(params: { domain: string; hubIp: string; dkimSelector?: string }) {
    return this.smtpDnsService.checkDnsRecords(params.domain, params.hubIp, params.dkimSelector);
  }
}
