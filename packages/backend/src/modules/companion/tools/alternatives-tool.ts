import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ToolRegistry } from './tool-registry';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_DIR } from '@/common/constants';

interface AltEntry {
  name: string;
  icon: string | null;
  url: string | null;
  appSlug?: string;
}

interface AltItem {
  proprietary: AltEntry[];
  alternatives: AltEntry[];
}

@Injectable()
export class AlternativesTool implements OnModuleInit {
  private altsData: Record<string, AltItem[]> = {};

  constructor(private readonly toolRegistry: ToolRegistry) {}

  async onModuleInit() {
    // Load alternatives data — try frontend build asset first, then source
    try {
      const paths = [join(APP_DIR, 'assets', 'frontend', 'data', 'alts.json'), join(APP_DIR, '..', 'frontend', 'src', 'lib', 'data', 'alts.json')];

      for (const p of paths) {
        try {
          const raw = await readFile(p, 'utf-8');
          this.altsData = JSON.parse(raw);
          break;
        } catch {
          // path not available, try next
        }
      }
    } catch {
      // path not available
      // No alternatives data available
    }

    this.toolRegistry.register({
      name: 'find_alternative',
      description:
        'Find self-hosted alternatives to a proprietary service. Input a service name like "Google Photos", "Slack", "Microsoft Word" etc. Returns self-hosted apps that replace it.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'The proprietary service name (e.g. "Google Photos", "Slack", "Microsoft Word")' },
        },
        required: ['service'],
      },
      execute: async (args) => {
        const query = (args.service as string).toLowerCase();
        const results: Array<{ category: string; proprietary: string[]; alternatives: AltEntry[] }> = [];

        for (const [category, items] of Object.entries(this.altsData)) {
          for (const item of items) {
            const match = item.proprietary.some((p) => p.name.toLowerCase().includes(query));
            if (match) {
              results.push({
                category,
                proprietary: item.proprietary.map((p) => p.name),
                alternatives: item.alternatives,
              });
            }
          }
        }

        if (results.length === 0) {
          return JSON.stringify({
            message: `No alternatives found for "${args.service}". Try searching the app catalogue with search_apps instead.`,
          });
        }

        return JSON.stringify({ results });
      },
    });
  }
}
