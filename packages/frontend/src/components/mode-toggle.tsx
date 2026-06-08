import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useTheme } from '@/components/providers/theme/theme-provider';
import { useTranslation } from 'react-i18next';

export function ModeToggle() {
  const { setTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">{t('THEME_TOGGLE_SR')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>{t('THEME_LIGHT')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>{t('THEME_DARK')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>{t('THEME_SYSTEM')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
