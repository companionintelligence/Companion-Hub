import type { AppCategory } from '@/types/app.types';
import {
  Book,
  Bot,
  Brain,
  Camera,
  Clapperboard,
  Code,
  Database,
  Gamepad2,
  Music,
  PiggyBank,
  Plug,
  Radio,
  ShieldCheck,
  Star,
  Users,
  Waypoints,
  Wrench,
} from 'lucide-react';

/**
 * Whole class names, written out. Tailwind only emits classes it can see in
 * source, so a built `text-${name}` string never reaches the page.
 */
export const categoryIconClass: Record<string, string> = {
  network: 'text-sky-600',
  media: 'text-cyan-600',
  automation: 'text-indigo-600',
  development: 'text-red-600',
  utilities: 'text-muted-foreground',
  photography: 'text-purple-600',
  security: 'text-orange-600',
  social: 'text-yellow-600',
  featured: 'text-lime-600',
  data: 'text-green-600',
  books: 'text-teal-600',
  music: 'text-cyan-500',
  finance: 'text-stone-600',
  gaming: 'text-pink-600',
  ai: 'text-muted-foreground',
  agents: 'text-violet-600',
  mcp: 'text-violet-500',
};

export function iconClassForCategory(category: string): string {
  return categoryIconClass[category] ?? 'text-sky-600';
}

type AppCategoryEntry = {
  id: AppCategory;
  icon: typeof Book;
};

export const iconForCategory: AppCategoryEntry[] = [
  { id: 'featured', icon: Star },
  // Waypoints, not a Bot variant: Automation already owns Bot and AI owns Brain,
  // and the bot-family glyphs are indistinguishable at the 16px sidebar size.
  { id: 'agents', icon: Waypoints },
  { id: 'ai', icon: Brain },
  { id: 'automation', icon: Bot },
  { id: 'books', icon: Book },
  { id: 'data', icon: Database },
  { id: 'development', icon: Code },
  { id: 'finance', icon: PiggyBank },
  { id: 'gaming', icon: Gamepad2 },
  { id: 'mcp', icon: Plug },
  { id: 'media', icon: Clapperboard },
  { id: 'music', icon: Music },
  { id: 'network', icon: Radio },
  { id: 'photography', icon: Camera },
  { id: 'security', icon: ShieldCheck },
  { id: 'social', icon: Users },
  { id: 'utilities', icon: Wrench },
];
