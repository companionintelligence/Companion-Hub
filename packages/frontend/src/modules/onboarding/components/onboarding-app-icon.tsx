import { getMarketplaceAppImageUrl } from '@/lib/marketplace-image-url';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { OnboardingApp } from '../helpers/types';

interface OnboardingAppIconProps {
  app: Pick<OnboardingApp, 'appSlug' | 'name' | 'icon' | 'urn'>;
  size?: number;
  className?: string;
  /** Deterministic local glyph shown when the marketplace and portal images are unavailable. */
  fallback?: ReactNode;
}

function InitialFallback({ name, size, className, fallback }: { name: string; size: number; className?: string; fallback?: ReactNode }) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-foreground/10 text-sm font-semibold text-muted-foreground', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {fallback ?? name.charAt(0).toUpperCase()}
    </span>
  );
}

function RemoteIcon({
  sources,
  name,
  size,
  className,
  fallback,
}: {
  sources: string[];
  name: string;
  size: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);

  const src = sources[sourceIndex];
  if (!src) {
    return <InitialFallback name={name} size={size} className={className} fallback={fallback} />;
  }

  return (
    <img
      src={src}
      alt=""
      className={cn('shrink-0 rounded-md object-contain', className)}
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}

/**
 * Renders the best available icon for an onboarding app.
 * The Hub marketplace image proxy is the canonical source. Portal/alternatives metadata is the
 * next source, and a local glyph keeps an app recognizable when a catalog entry is still syncing.
 */
export function OnboardingAppIcon({ app, size = 36, className, fallback }: OnboardingAppIconProps) {
  const sources = [app.urn ? getMarketplaceAppImageUrl(app.urn) : '', app.icon].filter(
    (source, index, all) => source && all.indexOf(source) === index,
  );

  return <RemoteIcon key={sources.join('|')} sources={sources} name={app.name} size={size} className={className} fallback={fallback} />;
}
