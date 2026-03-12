import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Globe, Loader2, Trash2, Copy, Plus, Monitor, Shield } from 'lucide-react';
import { useState } from 'react';

interface VpnStatus {
  enabled: boolean;
  headscaleHealthy: boolean;
  tailscaleConnected: boolean;
  tailscaleIp: string | null;
  deviceCount: number;
}

interface VpnDevice {
  id: string;
  name: string;
  givenName: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  createdAt: string;
  user: string;
}

interface PreAuthKey {
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
  createdAt: string;
  user: string;
}

interface CloudflareStatus {
  tunnelEnabled: boolean;
  tunnelId: string | null;
  message: string;
}

const StatusBadge = ({ connected, label }: { connected: boolean; label: string }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${connected ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`} />
    {label}
  </span>
);

const formatLastSeen = (lastSeen: string) => {
  if (!lastSeen) return 'Never';
  const date = new Date(lastSeen);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

const VpnSection = () => {
  const queryClient = useQueryClient();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data: vpnStatus, isLoading } = useQuery<VpnStatus>({
    queryKey: ['vpn-status'],
    queryFn: async () => {
      const res = await fetch('/api/headscale/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: devicesData } = useQuery<{ success: boolean; devices: VpnDevice[] }>({
    queryKey: ['vpn-devices'],
    queryFn: async () => {
      const res = await fetch('/api/headscale/devices', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 15000,
  });

  const { data: keysData, refetch: refetchKeys } = useQuery<{ success: boolean; keys: PreAuthKey[] }>({
    queryKey: ['vpn-preauthkeys'],
    queryFn: async () => {
      const res = await fetch('/api/headscale/preauthkeys', { credentials: 'include' });
      return res.json();
    },
  });

  const createKey = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/headscale/preauthkey', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reusable: false, ephemeral: false, expirationHours: 24 }),
      });
      return res.json();
    },
    onSuccess: () => {
      refetchKeys();
    },
  });

  const removeDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/headscale/devices/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vpn-devices'] });
      queryClient.invalidateQueries({ queryKey: ['vpn-status'] });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading VPN...
      </div>
    );
  }

  const healthy = vpnStatus?.headscaleHealthy && vpnStatus?.tailscaleConnected;
  const devices = devicesData?.devices || [];
  const activeKeys = (keysData?.keys || []).filter((k) => !k.used && new Date(k.expiration) > new Date());

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <span className="font-medium">Private VPN</span>
          </div>
          <StatusBadge connected={!!healthy} label={healthy ? 'Active' : 'Inactive'} />
        </div>
        <p className="text-sm text-muted-foreground">
          {healthy
            ? 'Your Hub is running a private VPN. Invited devices can securely access your apps from anywhere.'
            : 'The VPN service is starting up or unavailable. It will activate automatically.'}
        </p>
        {vpnStatus?.tailscaleIp && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="text-muted-foreground">Hub VPN Address</div>
            <div className="font-mono">{vpnStatus.tailscaleIp}</div>
            <div className="text-muted-foreground">Connected Devices</div>
            <div>{vpnStatus.deviceCount}</div>
          </div>
        )}
      </div>

      {/* Devices */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            Devices
          </h4>
          <span className="text-xs text-muted-foreground">{devices.length} connected</span>
        </div>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices connected yet. Generate an invite key below to add one.</p>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => (
              <div key={device.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`h-2 w-2 rounded-full ${device.online ? 'bg-green-500' : 'bg-gray-400'}`} />
                  <div>
                    <div className="font-medium">{device.givenName || device.name}</div>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{device.ipAddresses[0]}</span>
                      <span className="mx-1.5">·</span>
                      {device.online ? 'Online' : `Last seen ${formatLastSeen(device.lastSeen)}`}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeDevice.mutate(device.id)}
                  disabled={removeDevice.isPending}
                  className="text-muted-foreground hover:text-destructive p-1 disabled:opacity-50"
                  title="Remove device"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invite */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium">Invite a Device</h4>
          <button
            type="button"
            onClick={() => createKey.mutate()}
            disabled={createKey.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createKey.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Generate Key
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Generate a key and share it with the device you want to connect. Each key can be used once and expires after 24 hours.
        </p>
        {activeKeys.length > 0 && (
          <div className="space-y-2">
            {activeKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-md bg-muted/50 border px-3 py-2 text-sm">
                <div>
                  <div className="font-mono text-xs select-all">{key.key}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Expires {new Date(key.expiration).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    {key.reusable && ' · Reusable'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(key.key)}
                  className="text-muted-foreground hover:text-foreground p-1 ml-2 shrink-0"
                  title="Copy key"
                >
                  {copiedKey === key.key ? <span className="text-xs text-green-500">Copied!</span> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const CloudflareSection = () => {
  const { t } = useTranslation();

  const { data: status, isLoading } = useQuery<CloudflareStatus>({
    queryKey: ['cloudflare-status'],
    queryFn: async () => {
      const res = await fetch('/api/cloudflare/status', { credentials: 'include' });
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('SETTINGS_NETWORK_LOADING')}
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-primary" />
          <span className="font-medium">Cloudflare Tunnel</span>
        </div>
        <StatusBadge
          connected={!!status?.tunnelEnabled}
          label={status?.tunnelEnabled ? t('SETTINGS_NETWORK_ACTIVE') : t('SETTINGS_NETWORK_INACTIVE')}
        />
      </div>
      {status?.tunnelId && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">{t('SETTINGS_NETWORK_TUNNEL_ID')}</div>
          <div className="font-mono text-xs">{status.tunnelId}</div>
        </div>
      )}
      <p className="text-sm text-muted-foreground mt-2">{status?.message}</p>
    </div>
  );
};

export const NetworkSettingsContainer = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium mb-1">{t('SETTINGS_NETWORK_TITLE')}</h3>
        <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_DESC')}</p>
      </div>

      <VpnSection />
      <CloudflareSection />
    </div>
  );
};
