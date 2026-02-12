import * as React from 'react';
import { cn } from '@/lib/utils';

interface InputGroupProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | React.ReactNode;
  isInvalid?: boolean;
  groupPrefix?: string | React.ReactNode;
  groupSuffix?: string | React.ReactNode;
  groupClassName?: string;
}

export const InputGroup = React.forwardRef<HTMLInputElement, InputGroupProps>(
  ({ name, label, error, type = 'text', className, isInvalid, groupPrefix, groupSuffix, groupClassName, id, ...rest }, ref) => {
    const renderPrefix = () => {
      if (!groupPrefix) return null;
      if (typeof groupPrefix === 'string') {
        return (
          <div className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
            {groupPrefix}
          </div>
        );
      }
      return <div className="flex items-center">{groupPrefix}</div>;
    };

    const renderSuffix = () => {
      if (!groupSuffix) return null;
      if (typeof groupSuffix === 'string') {
        return (
          <div className="flex items-center rounded-r-md border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground">
            {groupSuffix}
          </div>
        );
      }
      return <div className="flex items-center">{groupSuffix}</div>;
    };

    return (
      <div className={cn('space-y-2', className)}>
        {label && (
          <label htmlFor={id || name} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
            {label}
          </label>
        )}
        <div className={cn('flex w-full shadow-sm', groupClassName)}>
          {renderPrefix()}
          <input
            ref={ref}
            type={type}
            name={name}
            id={id || name}
            className={cn(
              'flex h-9 w-full border border-input bg-transparent px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
              groupPrefix ? 'rounded-l-none' : 'rounded-l-md',
              groupSuffix ? 'rounded-r-none' : 'rounded-r-md',
              (error || isInvalid) && 'border-destructive focus-visible:ring-destructive',
            )}
            {...rest}
          />
          {renderSuffix()}
        </div>
        {error && <p className="text-[0.8rem] font-medium text-destructive">{error}</p>}
      </div>
    );
  },
);

InputGroup.displayName = 'InputGroup';
