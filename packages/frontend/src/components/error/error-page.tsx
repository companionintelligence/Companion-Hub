import { RotateCw } from 'lucide-react';
import { Button } from '../ui/Button';

type ErrorPageProps = {
  onReset: () => void;
  error: Error;
};

export const ErrorPage = ({ error, onReset }: ErrorPageProps) => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-xl font-semibold text-foreground mb-2">Oops... An error occurred!</p>
        <p className="text-sm text-muted-foreground mb-4">
          Try refreshing the page or click the button below to try again. If the problem persists, open an issue on GitHub with the error message
          below.
        </p>
        <div className="mb-4">
          <Button intent="primary" onClick={onReset}>
            <RotateCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
        <pre className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 text-left overflow-auto" style={{ whiteSpace: 'normal' }}>
          {error.message}
          <br />
          Location: {location.pathname}
        </pre>
      </div>
    </div>
  );
};
