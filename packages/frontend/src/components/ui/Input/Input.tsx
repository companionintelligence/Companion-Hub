import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | React.ReactNode;
  helpText?: string | React.ReactNode;
  isInvalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', error, label, helpText, isInvalid, children, id, name, ...props }, ref) => {
    return (
      <div className={cn('space-y-2', className)}>
        {label && (
          <label htmlFor={id || name} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            {label}
          </label>
        )}
        <input
          ref={ref}
          type={type}
          name={name}
          id={id || name}
          // shadcn input styles
          className={cn(
            'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
            (error || isInvalid) && 'border-destructive focus-visible:ring-destructive',
          )}
          {...props}
        />
        {helpText && <p className="text-[0.8rem] text-muted-foreground">{helpText}</p>}
        {children}
        {error && <p className="text-[0.8rem] font-medium text-destructive">{error}</p>}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
