import { type JSX, splitProps } from 'solid-js';
import { clsx } from 'clsx';

export type ButtonVariant = 'default' | 'ghost' | 'outline' | 'destructive';
export type ButtonSize = 'default' | 'sm' | 'icon';

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-md px-3 text-sm',
  icon: 'h-10 w-10',
};

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['variant', 'size', 'class', 'children']);
  return (
    <button
      class={clsx(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
        variantClasses[local.variant ?? 'default'],
        sizeClasses[local.size ?? 'default'],
        local.class,
      )}
      {...rest}
    >
      {local.children}
    </button>
  );
}

export function buttonVariants(opts: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return clsx(
    'inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
    variantClasses[opts.variant ?? 'default'],
    sizeClasses[opts.size ?? 'default'],
  );
}
