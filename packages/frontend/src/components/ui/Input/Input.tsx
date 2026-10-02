import * as React from 'react';
import { cn } from '@/lib/utils';
import { splitNamedLabel } from '@/lib/named-label';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | React.ReactNode;
  helpText?: string | React.ReactNode;
  isInvalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', error, label, helpText, isInvalid, children, id, name, 'aria-describedby': describedByProp, ...props }, ref) => {
    const errorId = React.useId();
    const helpId = React.useId();
    const describedBy = [describedByProp, helpText ? helpId : undefined, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
    const labelParts = label ? splitNamedLabel(label) : null;

    return (
      <div className={cn('space-y-2', className)}>
        {labelParts && (
          <div className="inline-flex items-center text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            <label htmlFor={id || name}>{labelParts.named}</label>
            {labelParts.extra}
          </div>
        )}
        <div className="relative">
          <input
            ref={ref}
            type={type}
            name={name}
            id={id || name}
            aria-invalid={error || isInvalid ? true : undefined}
            aria-describedby={describedBy}
            // shadcn input styles
            className={cn(
              'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
              (error || isInvalid) && 'border-destructive focus-visible:ring-destructive',
            )}
            {...props}
          />
          {children}
        </div>
        {helpText && (
          <p id={helpId} className="text-[0.8rem] text-muted-foreground">
            {helpText}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-[0.8rem] font-medium text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
