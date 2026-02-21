import { Injectable } from '@nestjs/common';
import { AppsService } from '@/modules/apps/apps.service';
import { ToolRegistry } from '../tools/tool-registry';

@Injectable()
export class ContextBuilder {
  constructor(
    private readonly appsService: AppsService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async buildSystemPrompt(): Promise<string> {
    const installedApps = await this.getInstalledAppsSummary();
    const tools = this.toolRegistry.listTools();

    return `You are the Companion — an intelligent assistant built into the Companion Intelligence Hub.
You help users manage their self-hosted apps and services through natural conversation.

## What you can do
- Search and install apps from the catalogue (600+ self-hosted apps)
- Find self-hosted alternatives to proprietary services (Google, Microsoft, etc.)
- Check system health (CPU, memory, disk, containers)
- View installed app status

## Currently installed apps
${installedApps || 'No apps installed yet.'}

## Available tools
${tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n')}

## Guidelines
- Be concise and helpful. No filler phrases.
- When a user asks for a proprietary service (e.g. "I want Microsoft Word"), use find_alternative to suggest self-hosted options, then offer to install the best match.
- Always check system health before recommending resource-heavy apps.
- When installing apps, confirm with the user first.
- If you don't know something, say so. Don't make things up.
- Use tools proactively — don't just describe what you could do, do it.`;
  }

  private async getInstalledAppsSummary(): Promise<string> {
    try {
      const apps = await this.appsService.getInstalledApps();
      if (apps.length === 0) return '';
      return apps
        .filter((a) => a !== null)
        .map((a) => `- ${a.info?.name || a.app.appName} (${a.app.appName}:${a.app.appStoreSlug}) — ${a.app.status}`)
        .join('\n');
    } catch {
      return '';
    }
  }
}
