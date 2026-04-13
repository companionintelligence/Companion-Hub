import { Home, Store, Settings } from 'lucide-solid';

export default function DashboardPage() {
  return (
    <div class="space-y-6">
      <h1 class="text-3xl font-bold">Dashboard</h1>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div class="rounded-xl border bg-card text-card-foreground shadow p-6">
          <div class="flex items-center gap-3 mb-3">
            <Home class="size-5 text-muted-foreground" />
            <h3 class="font-semibold">Welcome</h3>
          </div>
          <p class="text-sm text-muted-foreground">Your Companion Hub is running.</p>
        </div>
        <div class="rounded-xl border bg-card text-card-foreground shadow p-6">
          <div class="flex items-center gap-3 mb-3">
            <Store class="size-5 text-muted-foreground" />
            <h3 class="font-semibold">App Store</h3>
          </div>
          <p class="text-sm text-muted-foreground">Browse and install apps from the store.</p>
        </div>
        <div class="rounded-xl border bg-card text-card-foreground shadow p-6">
          <div class="flex items-center gap-3 mb-3">
            <Settings class="size-5 text-muted-foreground" />
            <h3 class="font-semibold">Settings</h3>
          </div>
          <p class="text-sm text-muted-foreground">Configure your hub settings.</p>
        </div>
      </div>
    </div>
  );
}
