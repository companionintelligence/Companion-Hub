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
  { id: 'network', icon: Radio },
  { id: 'media', icon: Clapperboard },
  { id: 'development', icon: Code },
  { id: 'automation', icon: Bot },
  { id: 'social', icon: Users },
  { id: 'utilities', icon: Wrench },
  { id: 'photography', icon: Camera },
  { id: 'security', icon: ShieldCheck },
  { id: 'featured', icon: Star },
  { id: 'books', icon: Book },
  { id: 'data', icon: Database },
  { id: 'music', icon: Music },
  { id: 'finance', icon: PiggyBank },
  { id: 'gaming', icon: Gamepad2 },
  { id: 'ai', icon: Brain },
];
