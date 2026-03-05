import { Loader2 } from 'lucide-react';

export const LoadingSpinner = ({ className }: { className?: string }) => (
  <div className={`flex items-center justify-center p-8 ${className ?? ''}`}>
    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
  </div>
);

export const PageLoadingSpinner = () => (
  <div className="flex items-center justify-center h-full w-full min-h-[50vh]">
    <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
  </div>
);
