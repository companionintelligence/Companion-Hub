import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // Mapped legacy variants
        success: 'bg-green-600 text-white shadow hover:bg-green-700',
        warning: 'bg-yellow-500 text-white shadow hover:bg-yellow-600',
        info: 'bg-blue-500 text-white shadow hover:bg-blue-600',
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

    // Map legacy intent to variant if variant is not provided (or to override if needed)
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
        {loading && !asChild && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
