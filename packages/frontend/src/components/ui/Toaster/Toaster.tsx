import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '@/components/providers/theme/theme-provider';

/*
 * Kept in step with the Portal's Toaster (CI-Portal apps/web-app/src/components/ui/sonner.tsx)
 * and the shared one in CI-Common (@companionintelligence/ui), so a toast looks the same in
 * every app.
 *
 * Sonner injects its stylesheet unlayered, and unlayered CSS outranks every Tailwind utility
 * (those sit in a cascade layer), so plain `bg-*` / `text-*` classes on a toast silently lose.
 * The card's colours go in through Sonner's own custom properties, set inline on the toaster,
 * and the few properties it hard-codes are overridden with `!` utilities. `whitespace-pre-line`
 * keeps a `\n` in a message as a line break, as react-hot-toast did.
 */
const TOKEN_STYLE = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
  fontFamily: 'var(--font-sans)',
} as CSSProperties;

const ICON_CLASS = 'size-5';

const ICONS: ToasterProps['icons'] = {
  success: <CircleCheck className={`${ICON_CLASS} text-success`} />,
  error: <CircleX className={`${ICON_CLASS} text-destructive`} />,
  warning: <TriangleAlert className={`${ICON_CLASS} text-warning`} />,
  info: <Info className={`${ICON_CLASS} text-info`} />,
};

export const Toaster = (props: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      position="bottom-center"
      style={TOKEN_STYLE}
      icons={ICONS}
      toastOptions={{
        classNames: {
          toast: '!text-sm',
          icon: '!size-5',
          title: 'whitespace-pre-line',
          description: '!text-muted-foreground whitespace-pre-line',
          actionButton: '!bg-primary !text-primary-foreground',
          cancelButton: '!bg-muted !text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};
