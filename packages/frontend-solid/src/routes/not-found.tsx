import { A } from '@solidjs/router';

export default function NotFound() {
  return (
    <div class="flex flex-col items-center justify-center min-h-screen">
      <h1 class="text-6xl font-bold mb-4">404</h1>
      <p class="text-muted-foreground mb-6">The requested page could not be found.</p>
      <A href="/dashboard" class="text-primary underline hover:no-underline">
        Go to Dashboard
      </A>
    </div>
  );
}
