import { cn } from '@/lib/utils';
import type React from 'react';

export interface GlassContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  intensity?: 'low' | 'medium' | 'high';
  border?: boolean;
}

export const GlassContainer: React.FC<GlassContainerProps> = ({ children, className, intensity = 'medium', border = true, ...props }) => {
  const intensityClasses = {
    low: 'bg-white/5 dark:bg-black/5 backdrop-blur-sm',
    medium: 'bg-white/10 dark:bg-black/10 backdrop-blur-md',
    high: 'bg-white/20 dark:bg-black/20 backdrop-blur-lg',
  };

  return (
    <div
      className={cn(
        'rounded-xl transition-colors duration-200',
        intensityClasses[intensity],
        border && 'border border-white/20 dark:border-white/10',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};
