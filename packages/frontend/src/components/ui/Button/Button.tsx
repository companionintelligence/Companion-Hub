import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Pressed state: every variant darkens its own resting background by 15% via
 * `color-mix(… 85%, black)`. Mixing toward black rather than fading alpha is
 * deliberate — an alpha fade moves the fill toward the page behind it, which
 * darkens in the dark theme but *lightens* in the light one, so a press would
 * read backwards in half the app. `link` is intentionally absent: it has no
 * background to darken. `active` sorts after `hover` in Tailwind's variant
 * order, so the press wins while the pointer is still hovering.
 *
 * The 15% is measured against whatever the button shows *just before* the
 * press, which is the hover fill for a mouse user. For most variants hover is
 * an alpha fade or an accent swap, so mixing from the resting colour lands
 * 15% below hover. `success`/`warning`/`info` are the exception: their hover
 * is already a darker palette step that spends the whole budget, so mixing
 * from *their* hover step is what keeps the press visible — otherwise pressing
 * success was 1% lighter than hovering it.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 active:bg-[color-mix(in_oklab,var(--primary)_85%,black)]',
        destructive:
          'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-[color-mix(in_oklab,var(--destructive)_85%,black)]',
        outline:
          'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:bg-[color-mix(in_oklab,var(--accent)_85%,black)] active:text-accent-foreground',
        secondary:
          'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:bg-[color-mix(in_oklab,var(--secondary)_85%,black)]',
        ghost: 'hover:bg-accent hover:text-accent-foreground active:bg-[color-mix(in_oklab,var(--accent)_85%,black)] active:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        success: 'bg-green-600 text-white shadow hover:bg-green-700 active:bg-[color-mix(in_oklab,var(--color-green-700)_85%,black)]',
        warning: 'bg-yellow-500 text-white shadow hover:bg-yellow-600 active:bg-[color-mix(in_oklab,var(--color-yellow-600)_85%,black)]',
        info: 'bg-blue-500 text-white shadow hover:bg-blue-600 active:bg-[color-mix(in_oklab,var(--color-blue-600)_85%,black)]',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  intent?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'info' | 'dark' | 'light';
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, intent, size, asChild = false, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';

    // Map intent to variant if variant is not provided
    // We prioritize the explicit 'variant' prop if it exists.
    let finalVariant = variant;

    if (!finalVariant && intent) {
      const intentMap: Record<string, ButtonProps['variant']> = {
        default: 'default',
        primary: 'default',
        secondary: 'secondary',
        success: 'success',
        warning: 'warning',
        danger: 'destructive',
        info: 'info',
        dark: 'secondary',
        light: 'ghost',
      };
      finalVariant = intentMap[intent];
    }

    // Default to 'default' if nothing set
    if (!finalVariant) {
      finalVariant = 'default';
    }

    return (
      <Comp className={cn(buttonVariants({ variant: finalVariant, size, className }))} ref={ref} disabled={disabled || loading} {...props}>
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
