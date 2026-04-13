import { createSignal, Show, For } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Card, CardContent, Input } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';
import { rawApiFetch } from '@/api-client';

interface ServiceConfig {
  name: string;
  image: string;
  isMain: boolean;
  internalPort: number;
  environment: Array<{ key: string; value: string }>;
  volumes: Array<{ hostPath: string; containerPath: string }>;
}

export default function CustomAppCreatePage() {
  const navigate = useNavigate();
  const [appName, setAppName] = createSignal('');
  const [appDescription, setAppDescription] = createSignal('');
  const [services, setServices] = createSignal<ServiceConfig[]>([{
    name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80, environment: [], volumes: [],
  }]);
  const [loading, setLoading] = createSignal(false);

  const addService = () => {
    setServices((prev) => [...prev, {
      name: `service-${prev.length + 1}`, image: '', isMain: false, internalPort: 80, environment: [], volumes: [],
    }]);
  };

  const updateService = (index: number, field: keyof ServiceConfig, value: unknown) => {
    setServices((prev) => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  };

  const removeService = (index: number) => {
    if (services().length <= 1) return;
    setServices((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!appName() || services().some((s) => !s.image)) {
      toast.error('Please fill in all required fields');
      return;
    }
    setLoading(true);
    try {
      const res = await rawApiFetch('/apps/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: appName(),
          description: appDescription(),
          services: services(),
        }),
      });
      if (!res.ok) throw new Error('Failed to create app');
      toast.success('Custom app created');
      navigate('/apps');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create app');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h2 class="text-2xl font-bold tracking-tight">Create Custom App</h2>
          <p class="text-muted-foreground">Deploy a custom Docker application</p>
        </div>

        <form onSubmit={handleSubmit} class="space-y-6">
          <Card>
            <CardContent class="p-6 space-y-4">
              <Input label="App Name" value={appName()} onInput={(e) => setAppName(e.currentTarget.value)} placeholder="my-app" />
              <Input label="Description" value={appDescription()} onInput={(e) => setAppDescription(e.currentTarget.value)} placeholder="A brief description" />
            </CardContent>
          </Card>

          <For each={services()}>
            {(service, index) => (
              <Card>
                <CardContent class="p-6 space-y-4">
                  <div class="flex items-center justify-between">
                    <h3 class="font-semibold">Service {index() + 1}</h3>
                    <Show when={services().length > 1}>
                      <Button variant="ghost" size="sm" onClick={() => removeService(index())} class="text-destructive">Remove</Button>
                    </Show>
                  </div>
                  <Input label="Service Name" value={service.name} onInput={(e) => updateService(index(), 'name', e.currentTarget.value)} />
                  <Input label="Docker Image" value={service.image} onInput={(e) => updateService(index(), 'image', e.currentTarget.value)} placeholder="nginx:alpine" />
                  <Input label="Internal Port" type="number" value={String(service.internalPort)} onInput={(e) => updateService(index(), 'internalPort', Number(e.currentTarget.value))} />
                  <label class="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={service.isMain} onChange={(e) => updateService(index(), 'isMain', e.currentTarget.checked)} class="rounded" />
                    Main service (will be exposed)
                  </label>
                </CardContent>
              </Card>
            )}
          </For>

          <Button variant="outline" type="button" onClick={addService}>+ Add Service</Button>

          <div class="flex gap-3">
            <Button variant="outline" type="button" onClick={() => navigate('/apps')}>Cancel</Button>
            <Button type="submit" disabled={loading()}>{loading() ? 'Creating...' : 'Create App'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
