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
  Radio,
  ShieldCheck,
  Star,
  Users,
  Wrench,
} from 'lucide-react';

export const colorSchemeForCategory: Record<string, string> = {
  network: 'blue',
  media: 'azure',
  automation: 'indigo',
  development: 'red',
  utilities: 'muted',
  photography: 'purple',
  security: 'orange',
  social: 'yellow',
  featured: 'lime',
  data: 'green',
  books: 'teal',
  music: 'cyan',
  finance: 'dark',
  gaming: 'pink',
  ai: 'muted',
};

type AppCategoryEntry = {
  id: AppCategory;
  icon: typeof Book;
};

export const iconForCategory: AppCategoryEntry[] = [
  { id: 'featured', icon: Star },
  { id: 'ai', icon: Brain },
  { id: 'automation', icon: Bot },
  { id: 'books', icon: Book },
  { id: 'data', icon: Database },
  { id: 'development', icon: Code },
  { id: 'finance', icon: PiggyBank },
  { id: 'gaming', icon: Gamepad2 },
  { id: 'media', icon: Clapperboard },
  { id: 'music', icon: Music },
  { id: 'network', icon: Radio },
  { id: 'photography', icon: Camera },
  { id: 'security', icon: ShieldCheck },
  { id: 'social', icon: Users },
  { id: 'utilities', icon: Wrench },
];
