import type * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn } from '@/lib/utils';
import { useId } from 'react';

type RootProps = typeof CheckboxPrimitive.Root;

type CheckboxProps = React.ComponentPropsWithoutRef<RootProps> & {
  label?: string | React.ReactNode;
  ref?: React.Ref<React.ElementRef<RootProps>>;
};

function Checkbox({ className, label, ...props }: CheckboxProps) {
  const generatedId = useId();
  const baseId = props.name ? `${props.name}-${generatedId}` : generatedId;
  const inputId = props.id || baseId;
  const labelId = `${baseId}-label`;

  return (
    <label htmlFor={inputId} className={cn('flex items-center gap-2', className)}>
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 rounded border border-input ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 accent-primary"
        checked={props.checked as boolean}
        onChange={(e) => props.onCheckedChange?.(e.target.checked)}
        name={props.name}
        id={inputId}
        aria-labelledby={labelId}
      />
      <span id={labelId} className="text-sm font-medium text-foreground">
        {label}
      </span>
    </label>
  );
}

export { Checkbox };
