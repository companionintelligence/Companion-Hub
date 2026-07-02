import { AppLogo } from '@/components/app-logo/app-logo';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import type { OnboardingApp } from '../helpers/types';

interface OnboardingAppIconProps {
  app: Pick<OnboardingApp, 'appSlug' | 'name' | 'icon' | 'urn'>;
  size?: number;
  className?: string;
}

function InitialFallback({ name, size, className }: { name: string; size: number; className?: string }) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-foreground/10 text-sm font-semibold text-muted-foreground', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function RemoteIcon({ src, name, size, className }: { src: string; name: string; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return <InitialFallback name={name} size={size} className={className} />;
  }

  return (
    <img
      src={src}
      alt=""
      className={cn('shrink-0 rounded-md object-contain', className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

/** Renders the best available icon for an onboarding app (portal icon URL, store URN, remote URL, or initial fallback). */
export function OnboardingAppIcon({ app, size = 36, className }: OnboardingAppIconProps) {
  if (app.icon) {
    return <RemoteIcon src={app.icon} name={app.name} size={size} className={className} />;
  }

  if (app.urn) {
    return <AppLogo urn={app.urn} alt={app.name} size={size} className={cn('shrink-0', className)} />;
  }

  return <InitialFallback name={app.name} size={size} className={className} />;
}
