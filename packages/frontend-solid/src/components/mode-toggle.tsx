import { useTheme } from '@/components/providers/theme/theme-provider';
import { Button } from '@/components/ui/Button';
import { Sun, Moon } from 'lucide-solid';

export function ModeToggle() {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const current = theme();
    if (current === 'light') setTheme('dark');
    else if (current === 'dark') setTheme('system');
    else setTheme('light');
  };

  return (
    <Button variant="ghost" size="icon" onClick={cycleTheme} title="Toggle theme">
      <Sun class="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon class="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span class="sr-only">Toggle theme</span>
    </Button>
  );
}
